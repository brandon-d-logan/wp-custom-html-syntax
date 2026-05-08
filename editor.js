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

    // Per-user dark-mode preference, persisted in localStorage so it
    // applies to every Custom HTML block this user edits in this browser.
    // The value is mirrored across tabs via the `storage` event (below).
    const STORAGE_KEY = 'chsh:darkMode';
    const DARK_THEME  = 'chsh-dark';
    const LIGHT_THEME = 'default';
    const DARK_EVENT  = 'chsh:darkmode-changed';

    function getDarkMode() {
        try {
            return window.localStorage.getItem( STORAGE_KEY ) === '1';
        } catch ( e ) {
            return false;
        }
    }

    function currentTheme() {
        return getDarkMode() ? DARK_THEME : LIGHT_THEME;
    }

    // Live registry of attached CodeMirror instances so we can repaint
    // them when the user toggles. Filtered on each iteration to drop
    // editors whose wrapper has been detached from the DOM.
    const cmInstances = [];

    function applyThemeToAll( theme ) {
        for ( let i = cmInstances.length - 1; i >= 0; i-- ) {
            const cm = cmInstances[ i ];
            let wrapper;
            try { wrapper = cm.getWrapperElement(); } catch ( e ) {}
            if ( ! wrapper || ! wrapper.isConnected ) {
                cmInstances.splice( i, 1 );
                continue;
            }
            try { cm.setOption( 'theme', theme ); } catch ( e ) {}
        }
    }

    function setDarkMode( enabled ) {
        try {
            window.localStorage.setItem( STORAGE_KEY, enabled ? '1' : '0' );
        } catch ( e ) {}
        applyThemeToAll( enabled ? DARK_THEME : LIGHT_THEME );
        window.dispatchEvent( new CustomEvent( DARK_EVENT, {
            detail: { enabled: !! enabled },
        } ) );
    }

    window.addEventListener( 'storage', function ( e ) {
        if ( e.key !== STORAGE_KEY ) return;
        const enabled = e.newValue === '1';
        applyThemeToAll( enabled ? DARK_THEME : LIGHT_THEME );
        window.dispatchEvent( new CustomEvent( DARK_EVENT, {
            detail: { enabled: enabled },
        } ) );
    } );

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
        cm.theme             = currentTheme();
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
        cm.lint = false;

        // Code folding. WP's bundled wp-codemirror concatenates the
        // foldcode/foldgutter addons and the per-mode rangefinders
        // (xml-fold for htmlmixed, brace-fold for js/css, comment-fold).
        // Picking the rangefinder by mode keeps htmlmixed folding tags
        // *and* embedded <script>/<style> braces.
        //   https://codemirror.net/5/doc/manual.html#addon_foldcode
        //   https://codemirror.net/5/doc/manual.html#addon_foldgutter
        const CM = window.wp && window.wp.CodeMirror;
        if ( CM && CM.fold ) {
            cm.foldGutter = true;
            cm.foldOptions = {
                rangeFinder: CM.fold.combine.apply( null, [
                    CM.fold.xml,
                    CM.fold.brace,
                    CM.fold.comment,
                    CM.fold.indent,
                ].filter( Boolean ) ),
            };
        }
        cm.gutters = [
            'CodeMirror-linenumbers',
            'CodeMirror-foldgutter',
        ];

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

        cmInstances.push( cm );

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
            // Toggle the fold containing the cursor — the conventional
            // CodeMirror foldcode keybinding.
            'Ctrl-Q': function ( editor ) {
                editor.foldCode( editor.getCursor() );
            },
            'Cmd-Q': function ( editor ) {
                editor.foldCode( editor.getCursor() );
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

    // Inject a "Dark mode" toggle into the core/html block toolbar via
    // the documented `editor.BlockEdit` filter. The HOC wraps every
    // BlockEdit, but only renders extra controls for core/html so other
    // blocks stay untouched.
    //   editor.BlockEdit:
    //     https://developer.wordpress.org/block-editor/reference-guides/filters/block-filters/#editor-blockedit
    //   BlockControls:
    //     https://developer.wordpress.org/block-editor/reference-guides/components/block-controls/
    //   CodeMirror theme option:
    //     https://codemirror.net/5/doc/manual.html#option_theme
    if (
        wp.element &&
        wp.compose &&
        wp.blockEditor &&
        wp.components &&
        wp.hooks
    ) {
        const el                       = wp.element.createElement;
        const Fragment                 = wp.element.Fragment;
        const useState                 = wp.element.useState;
        const useEffect                = wp.element.useEffect;
        const createHigherOrderComponent =
            wp.compose.createHigherOrderComponent;
        const BlockControls            = wp.blockEditor.BlockControls;
        const ToolbarGroup             = wp.components.ToolbarGroup;
        const ToolbarButton            = wp.components.ToolbarButton;
        const addFilter                = wp.hooks.addFilter;
        const __                       =
            ( wp.i18n && wp.i18n.__ ) || function ( s ) { return s; };

        const moonIcon = el(
            'svg',
            {
                xmlns:         'http://www.w3.org/2000/svg',
                viewBox:       '0 0 24 24',
                width:         24,
                height:        24,
                'aria-hidden': true,
                focusable:     false,
            },
            el( 'path', {
                fill: 'currentColor',
                d:    'M12 3a9 9 0 1 0 9 9 7 7 0 0 1-9-9z',
            } )
        );

        const withDarkModeToolbar = createHigherOrderComponent(
            function ( BlockEdit ) {
                return function ( props ) {
                    if ( props.name !== 'core/html' ) {
                        return el( BlockEdit, props );
                    }

                    const darkState = useState( getDarkMode() );
                    const dark      = darkState[ 0 ];
                    const setDark   = darkState[ 1 ];

                    useEffect( function () {
                        function handler( event ) {
                            setDark( !! ( event.detail && event.detail.enabled ) );
                        }
                        window.addEventListener( DARK_EVENT, handler );
                        return function () {
                            window.removeEventListener( DARK_EVENT, handler );
                        };
                    }, [] );

                    return el(
                        Fragment,
                        null,
                        el( BlockEdit, Object.assign( { key: 'edit' }, props ) ),
                        el(
                            BlockControls,
                            { key: 'chsh-dark-mode' },
                            el(
                                ToolbarGroup,
                                null,
                                el( ToolbarButton, {
                                    icon:      moonIcon,
                                    label:     dark
                                        ? __( 'Switch to light mode', 'chsh' )
                                        : __( 'Switch to dark mode', 'chsh' ),
                                    isPressed: dark,
                                    onClick:   function () {
                                        setDarkMode( ! dark );
                                    },
                                } )
                            )
                        )
                    );
                };
            },
            'withChshDarkModeToolbar'
        );

        addFilter(
            'editor.BlockEdit',
            'chsh/dark-mode-toolbar',
            withDarkModeToolbar
        );
    } else {
        // eslint-disable-next-line no-console
        console.warn(
            '[chsh] block editor packages unavailable; ' +
            'dark-mode toolbar will not be registered.'
        );
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
