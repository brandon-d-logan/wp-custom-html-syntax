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
    const STORAGE_KEY  = 'chsh:darkMode';
    const DARK_THEME   = 'chsh-dark';
    const LIGHT_THEME  = 'default';
    const DARK_EVENT   = 'chsh:darkmode-changed';
    const EXPAND_EVENT = 'chsh:expand-changed';
    const EXPANDED_CLASS = 'chsh-expanded';

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

    // Pop-out / expanded mode. Toggling adds `chsh-expanded` to the
    // CodeMirror wrapper(s) inside a given block, which CSS turns into a
    // viewport-filling overlay so a long document is easier to read and
    // edit. Tracked by clientId so multiple blocks in the same post can
    // each be expanded/collapsed independently. Only one is typically open
    // at a time, but nothing here forces that.
    const expandedBlocks = new Set();

    function findCmWrappersForBlock( clientId ) {
        if ( ! clientId ) return [];
        const sel = '[data-block="' + clientId + '"] .CodeMirror';
        const found = [];
        function collect( doc ) {
            if ( ! doc || ! doc.querySelectorAll ) return;
            doc.querySelectorAll( sel ).forEach( function ( el ) {
                found.push( el );
            } );
        }
        collect( document );
        const iframes = document.querySelectorAll( 'iframe' );
        for ( let i = 0; i < iframes.length; i++ ) {
            try { collect( iframes[ i ].contentDocument ); } catch ( e ) {}
        }
        return found;
    }

    function setExpanded( clientId, expanded ) {
        if ( expanded ) {
            expandedBlocks.add( clientId );
        } else {
            expandedBlocks.delete( clientId );
        }
        const wrappers = findCmWrappersForBlock( clientId );
        wrappers.forEach( function ( wrapper ) {
            wrapper.classList.toggle( EXPANDED_CLASS, !! expanded );
            applyExpandedBounds( wrapper );
            // CodeMirror caches its viewport size; nudge it after the
            // wrapper resizes so the gutters/scroller redraw correctly.
            const cm = wrapper.CodeMirror;
            if ( cm ) {
                requestAnimationFrame( function () {
                    try {
                        cm.refresh();
                        if ( expanded ) cm.focus();
                    } catch ( e ) {}
                } );
            }
        } );
        updateBoundsListener();
        window.dispatchEvent( new CustomEvent( EXPAND_EVENT, {
            detail: { clientId: clientId, expanded: !! expanded },
        } ) );
    }

    // The expanded overlay needs to live inside the editor *canvas* — i.e.
    // not under the WP editor header or behind the right-hand sidebar.
    //
    // - In the iframed canvas (modern Gutenberg), the wrapper's
    //   ownerDocument is the iframe doc, whose viewport already excludes
    //   the chrome. position: fixed against that viewport is exactly what
    //   we want, so we leave inline styles cleared and let the CSS rule
    //   handle inset:24px.
    // - In the top doc (older inline-textarea path, or modal portal),
    //   position: fixed measures against the whole window, which slides
    //   under the editor header / sidebar. Measure the canvas region and
    //   apply matching inline coords instead.
    const CANVAS_CANDIDATES = [
        '.interface-interface-skeleton__content',
        '.editor-visual-editor',
        '.edit-post-visual-editor',
        '.editor-styles-wrapper',
    ];
    const EDGE_INSET = 24;

    function findCanvasRect() {
        for ( let i = 0; i < CANVAS_CANDIDATES.length; i++ ) {
            const el = document.querySelector( CANVAS_CANDIDATES[ i ] );
            if ( el ) {
                const r = el.getBoundingClientRect();
                if ( r.width > 0 && r.height > 0 ) return r;
            }
        }
        return null;
    }

    function clearBoundsStyles( style ) {
        style.top = style.left = style.right = style.bottom = '';
        style.width = style.height = '';
    }

    function applyExpandedBounds( wrapper ) {
        const expanded = wrapper.classList.contains( EXPANDED_CLASS );
        const style    = wrapper.style;
        if ( ! expanded ) {
            clearBoundsStyles( style );
            return;
        }
        // Iframe doc: defer to the CSS rule (inset:24px against the
        // iframe's own viewport, which already excludes the chrome).
        if ( wrapper.ownerDocument !== document ) {
            clearBoundsStyles( style );
            return;
        }
        const rect = findCanvasRect();
        if ( ! rect ) {
            clearBoundsStyles( style );
            return;
        }
        // Inline width/height + auto right/bottom take priority over the
        // stylesheet's `inset: 24px` shorthand so the overlay fits the
        // canvas region and not the whole window.
        style.top    = ( rect.top + EDGE_INSET ) + 'px';
        style.left   = ( rect.left + EDGE_INSET ) + 'px';
        style.right  = 'auto';
        style.bottom = 'auto';
        style.width  = Math.max( 0, rect.width  - EDGE_INSET * 2 ) + 'px';
        style.height = Math.max( 0, rect.height - EDGE_INSET * 2 ) + 'px';
    }

    function reapplyAllBounds() {
        expandedBlocks.forEach( function ( id ) {
            findCmWrappersForBlock( id ).forEach( function ( w ) {
                applyExpandedBounds( w );
                const cm = w.CodeMirror;
                if ( cm ) { try { cm.refresh(); } catch ( e ) {} }
            } );
        } );
    }

    // window.resize covers browser resize; a ResizeObserver on the canvas
    // covers the sidebar/inspector being toggled, which doesn't change
    // the window size but does shrink the canvas region we're tracking.
    let boundsListenerAttached = false;
    let canvasResizeObserver   = null;
    let observedCanvas         = null;

    function updateBoundsListener() {
        const want = expandedBlocks.size > 0;
        if ( want === boundsListenerAttached ) {
            // Even if listener state is unchanged, the canvas element may
            // have been swapped out (e.g. iframe re-mount); refresh it.
            if ( want ) syncCanvasObserver();
            return;
        }
        if ( want ) {
            window.addEventListener( 'resize', reapplyAllBounds );
            syncCanvasObserver();
        } else {
            window.removeEventListener( 'resize', reapplyAllBounds );
            if ( canvasResizeObserver ) {
                canvasResizeObserver.disconnect();
            }
            observedCanvas = null;
        }
        boundsListenerAttached = want;
    }

    function syncCanvasObserver() {
        if ( typeof window.ResizeObserver !== 'function' ) return;
        let canvasEl = null;
        for ( let i = 0; i < CANVAS_CANDIDATES.length; i++ ) {
            canvasEl = document.querySelector( CANVAS_CANDIDATES[ i ] );
            if ( canvasEl ) break;
        }
        if ( ! canvasEl || canvasEl === observedCanvas ) return;
        if ( ! canvasResizeObserver ) {
            canvasResizeObserver = new window.ResizeObserver( reapplyAllBounds );
        } else {
            canvasResizeObserver.disconnect();
        }
        canvasResizeObserver.observe( canvasEl );
        observedCanvas = canvasEl;
    }

    // ESC closes whatever is expanded. Listening on the top document is
    // enough for most setups; for the iframe canvas we also attach to each
    // iframe document we discover via watchDoc().
    function escHandler( e ) {
        if ( e.key !== 'Escape' || expandedBlocks.size === 0 ) return;
        const ids = Array.from( expandedBlocks );
        ids.forEach( function ( id ) { setExpanded( id, false ); } );
        e.stopPropagation();
    }
    document.addEventListener( 'keydown', escHandler, true );

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
        if ( doc !== document ) {
            doc.addEventListener( 'keydown', escHandler, true );
        }

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

        // Four corner brackets pointing outward — the conventional
        // "expand / fullscreen" affordance.
        const expandIcon = el(
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
                d:    'M5 5h5v2H7v3H5V5zm9 0h5v5h-2V7h-3V5zM5 14h2v3h3v2H5v-5zm12 0h2v5h-5v-2h3v-3z',
            } )
        );
        const collapseIcon = el(
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
                d:    'M10 5h2v5H7V8h3V5zm7 3V5h-2v5h5V8h-3zM5 14h5v5H8v-3H5v-2zm12 2h3v-2h-5v5h2v-3z',
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

                    const expandedState = useState(
                        expandedBlocks.has( props.clientId )
                    );
                    const expanded      = expandedState[ 0 ];
                    const setExpandedSt = expandedState[ 1 ];

                    useEffect( function () {
                        function handler( event ) {
                            setDark( !! ( event.detail && event.detail.enabled ) );
                        }
                        window.addEventListener( DARK_EVENT, handler );
                        return function () {
                            window.removeEventListener( DARK_EVENT, handler );
                        };
                    }, [] );

                    useEffect( function () {
                        function handler( event ) {
                            const d = event.detail || {};
                            if ( d.clientId !== props.clientId ) return;
                            setExpandedSt( !! d.expanded );
                        }
                        window.addEventListener( EXPAND_EVENT, handler );
                        return function () {
                            window.removeEventListener( EXPAND_EVENT, handler );
                        };
                    }, [ props.clientId ] );

                    // Collapse on unmount so a stale expanded flag can't
                    // outlive the block (e.g. if the user deletes it
                    // while the overlay is open).
                    useEffect( function () {
                        return function () {
                            if ( expandedBlocks.has( props.clientId ) ) {
                                setExpanded( props.clientId, false );
                            }
                        };
                    }, [ props.clientId ] );

                    return el(
                        Fragment,
                        null,
                        el( BlockEdit, Object.assign( { key: 'edit' }, props ) ),
                        el(
                            BlockControls,
                            { key: 'chsh-toolbar' },
                            el(
                                ToolbarGroup,
                                null,
                                el( ToolbarButton, {
                                    icon:      expanded ? collapseIcon : expandIcon,
                                    label:     expanded
                                        ? __( 'Collapse editor', 'chsh' )
                                        : __( 'Expand editor', 'chsh' ),
                                    isPressed: expanded,
                                    onClick:   function () {
                                        setExpanded( props.clientId, ! expanded );
                                    },
                                } ),
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
