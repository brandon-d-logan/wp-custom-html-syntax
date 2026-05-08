/* global CodeMirror, chshSettings, wp */
/**
 * Adds CodeMirror syntax highlighting to the Custom HTML block (core/html).
 *
 * Block API v3 (current trunk) doesn't render a textarea inside the block
 * itself — the block edit only shows a Placeholder or a Preview, with an
 * "Edit code" button that opens HTMLEditModal. The modal renders three
 * <PlainText> editors (HTML / CSS / JS) with class
 * `block-library-html__modal-editor`.
 *
 * So: we leave the block edit alone (replacing it broke the
 * Placeholder/Preview/Modal flow and tripped the block error boundary)
 * and enhance the modal's textareas when they appear in the DOM.
 *
 * Block source for reference:
 *   https://github.com/WordPress/gutenberg/tree/trunk/packages/block-library/src/html
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

    if ( typeof CodeMirror === 'undefined' ) {
        // eslint-disable-next-line no-console
        console.warn( '[chsh] CodeMirror not loaded; skipping.' );
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

    function attachEditor( textarea ) {
        if ( ! textarea || initialized.has( textarea ) ) return;
        initialized.add( textarea );

        log( 'attaching CodeMirror to', textarea );

        let cm;
        try {
            cm = CodeMirror.fromTextArea( textarea, {
                mode:              modeFor( textarea ),
                theme:             settingsTheme(),
                lineNumbers:       true,
                lineWrapping:      true,
                indentUnit:        settingsTabSize(),
                tabSize:           settingsTabSize(),
                indentWithTabs:    false,
                matchBrackets:     true,
                autoCloseBrackets: true,
                extraKeys: {
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
                },
            } );
        } catch ( err ) {
            // eslint-disable-next-line no-console
            console.error( '[chsh] CodeMirror init failed:', err );
            return;
        }

        // Push CodeMirror edits back into the React-controlled <textarea>
        // so PlainText's onChange fires and the modal's local state updates.
        const win = textarea.ownerDocument.defaultView || window;
        const nativeSetter = Object.getOwnPropertyDescriptor(
            win.HTMLTextAreaElement.prototype,
            'value'
        ).set;

        cm.on( 'change', function () {
            nativeSetter.call( textarea, cm.getValue() );
            textarea.dispatchEvent( new Event( 'input', { bubbles: true } ) );
        } );

        // Tab switches and modal mounting can leave CM with a stale layout.
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
