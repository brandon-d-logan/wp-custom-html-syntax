/* global chshSettings, wp */
/**
 * Adds CodeMirror syntax highlighting to the Custom HTML block (core/html).
 *
 * Uses WordPress's documented code editor API — wp.codeEditor.initialize()
 * — which delegates to the WP-bundled wp.CodeMirror. We do NOT rely on a
 * global `CodeMirror`, because WP's codemirror.min.js exposes itself as
 * `window.wp.CodeMirror`; a stray global `CodeMirror` from another plugin
 * can shadow it and lack `fromTextArea`.
 *
 * References:
 *   wp.codeEditor.initialize:
 *     https://developer.wordpress.org/reference/functions/wp_enqueue_code_editor/
 *   Bundled CodeMirror:
 *     wp-includes/js/codemirror/codemirror.min.js  (exports to wp.CodeMirror)
 *   core/html block (current WP, inline-textarea version):
 *     https://github.com/WordPress/gutenberg/blob/51437a9/packages/block-library/src/html/edit.js
 */
( function () {
    'use strict';

    // eslint-disable-next-line no-console
    const log = function () {
        if ( window.chshDebug !== false ) {
            // eslint-disable-next-line no-console
            console.log.apply( console, [ '[chsh]' ].concat(
                Array.prototype.slice.call( arguments )
            ) );
        }
    };

    log( 'editor.js loaded' );

    if ( ! window.wp || ! wp.codeEditor || ! wp.codeEditor.initialize ) {
        // eslint-disable-next-line no-console
        console.warn(
            '[chsh] wp.codeEditor.initialize unavailable; skipping.'
        );
        return;
    }

    // The Custom HTML block currently in WP renders an inline <PlainText>
    // (textarea.block-editor-plain-text) directly in the block when not in
    // Preview mode. Source (matches what 6.9 ships):
    //   https://github.com/WordPress/gutenberg/blob/51437a9/packages/block-library/src/html/edit.js
    //
    // The trunk-only modal version (Gutenberg #73108, Nov 2025) instead
    // renders textareas with class `block-library-html__modal-editor`
    // inside a portal-mounted Modal. We match both so the plugin works
    // before and after that change lands in core.
    const SELECTOR = [
        // Inline textarea inside the block wrapper.
        '[data-type="core/html"] textarea',
        '.wp-block-html textarea',
        // Modal-based editors (forward-compat).
        'textarea.block-library-html__modal-editor',
        '.block-library-html__modal-tab textarea',
        '.block-library-html__modal textarea',
    ].join( ', ' );
    const initialized = new WeakSet();
    const watchedDocs = new WeakSet();

    function settingsTabSize() {
        return ( window.chshSettings && chshSettings.tabSize ) || 2;
    }

    function settingsTheme() {
        return ( window.chshSettings && chshSettings.theme ) || 'default';
    }

    function modeFor( textarea ) {
        const label = ( textarea.getAttribute( 'aria-label' ) || '' )
            .toLowerCase();
        if ( label === 'css' ) return 'css';
        if ( label === 'javascript' ) return 'javascript';
        return 'htmlmixed';
    }

    function buildSettings( textarea ) {
        const base =
            ( window.chshSettings && chshSettings.codeEditor ) || {};
        // Clone so per-textarea overrides don't leak.
        const settings = JSON.parse( JSON.stringify( base ) );
        settings.codemirror = settings.codemirror || {};

        const cm = settings.codemirror;
        cm.mode              = modeFor( textarea );
        cm.theme             = settingsTheme();
        cm.lineNumbers       = true;
        cm.lineWrapping      = true;
        cm.indentUnit        = settingsTabSize();
        cm.tabSize           = settingsTabSize();
        cm.indentWithTabs    = false;
        cm.matchBrackets     = true;
        cm.autoCloseBrackets = true;

        // CSSLint / HTMLHint don't understand modern syntax (e.g. the CSS
        // Nesting Module) and produce false positives on valid code. We
        // only want highlighting, not linting — disable the linter and
        // drop its gutter.
        cm.lint    = false;
        cm.gutters = [ 'CodeMirror-linenumbers' ];

        return settings;
    }

    function attachEditor( textarea ) {
        if ( ! textarea || initialized.has( textarea ) ) return;
        initialized.add( textarea );

        log( 'attaching CodeMirror to', textarea );

        let instance;
        try {
            instance = wp.codeEditor.initialize(
                textarea,
                buildSettings( textarea )
            );
        } catch ( err ) {
            // eslint-disable-next-line no-console
            console.error( '[chsh] codeEditor.initialize failed:', err );
            return;
        }

        const cm = instance && instance.codemirror;
        if ( ! cm ) {
            // eslint-disable-next-line no-console
            console.error( '[chsh] no codemirror instance returned' );
            return;
        }

        // Push CodeMirror edits back into the React-controlled <textarea>
        // so PlainText's onChange fires and block attributes update.
        const win = textarea.ownerDocument.defaultView || window;
        const nativeSetter = Object.getOwnPropertyDescriptor(
            win.HTMLTextAreaElement.prototype,
            'value'
        ).set;

        cm.on( 'change', function () {
            nativeSetter.call( textarea, cm.getValue() );
            textarea.dispatchEvent( new Event( 'input', { bubbles: true } ) );
        } );

        // The Tab key would otherwise move focus; make it indent.
        cm.setOption( 'extraKeys', {
            Tab: function ( editor ) {
                if ( editor.somethingSelected() ) {
                    editor.indentSelection( 'add' );
                } else {
                    editor.replaceSelection(
                        ' '.repeat( settingsTabSize() ),
                        'end'
                    );
                }
            },
            'Shift-Tab': function ( editor ) {
                editor.indentSelection( 'subtract' );
            },
        } );

        cm.on( 'focus', function () {
            cm.refresh();
        } );
        requestAnimationFrame( function () {
            cm.refresh();
        } );
    }

    function scan( root ) {
        if ( ! root || ! root.querySelectorAll ) return;
        root.querySelectorAll( SELECTOR ).forEach( attachEditor );
    }

    function watchDoc( doc ) {
        if ( ! doc || ! doc.body || watchedDocs.has( doc ) ) return;
        watchedDocs.add( doc );
        log( 'watching document', doc === document ? '(top)' : '(iframe)' );
        scan( doc );

        const Observer =
            ( doc.defaultView && doc.defaultView.MutationObserver ) ||
            window.MutationObserver;

        new Observer( function ( mutations ) {
            for ( let i = 0; i < mutations.length; i++ ) {
                const added = mutations[ i ].addedNodes;
                for ( let j = 0; j < added.length; j++ ) {
                    const node = added[ j ];
                    if ( node.nodeType !== 1 ) continue;
                    if ( node.matches && node.matches( SELECTOR ) ) {
                        attachEditor( node );
                    } else {
                        scan( node );
                    }
                }
            }
        } ).observe( doc.body, { childList: true, subtree: true } );
    }

    function watchIframes() {
        // The Modal renders to a portal; in some setups the portal target is
        // inside the editor canvas iframe rather than the top document.
        const iframes = document.querySelectorAll( 'iframe' );
        for ( let i = 0; i < iframes.length; i++ ) {
            let doc;
            try { doc = iframes[ i ].contentDocument; } catch ( e ) { continue; }
            if ( doc ) watchDoc( doc );
            iframes[ i ].addEventListener( 'load', function () {
                try { watchDoc( iframes[ i ].contentDocument ); } catch ( e ) {}
            } );
        }
    }

    wp.domReady( function () {
        watchDoc( document );
        watchIframes();
        new MutationObserver( watchIframes ).observe( document.body, {
            childList: true,
            subtree:   true,
        } );
    } );
} )();
