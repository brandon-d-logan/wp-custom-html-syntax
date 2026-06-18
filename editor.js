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

    // Pre-7.0 the Custom HTML block rendered an inline <PlainText>
    // (textarea.block-editor-plain-text) directly inside the block when
    // not in Preview mode:
    //   https://github.com/WordPress/gutenberg/blob/51437a9/packages/block-library/src/html/edit.js
    //
    // WP 7.0 (Gutenberg #73108) replaced that with a tabbed modal — HTML,
    // CSS, JS tabs each holding a PlainText editor with class
    // `block-library-html__modal-editor` inside `.block-library-html__modal`.
    //
    // Critically, a `<TabPanel descendant> textarea` selector over-matches
    // in the new layout: PlainText / textarea-autosize can produce an
    // additional shadow textarea per editor, so a broad descendant match
    // ends up wrapping two textareas in each tab — that's the "duplicate
    // field per tab" symptom in 7.0. On 7.0+ we therefore scope strictly
    // to the editor textarea's own class. Pre-7.0 keeps the original wide
    // selector list since the older block doesn't expose that class.
    const isWp70Plus = !! (
        window.chshSettings && chshSettings.isWp70Plus
    );
    const SELECTOR = isWp70Plus
        ? 'textarea.block-library-html__modal-editor'
        : [
            '[data-type="core/html"] textarea',
            '.wp-block-html textarea',
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
    const HEADER_CLASS   = 'chsh-expand-header';
    const HEADER_DARK_CLASS = 'chsh-expand-header--dark';
    const HEADER_HEIGHT  = 36;

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

    function applyHeaderTheme() {
        const dark = getDarkMode();
        function paint( doc ) {
            if ( ! doc || ! doc.querySelectorAll ) return;
            doc.querySelectorAll( '.' + HEADER_CLASS ).forEach( function ( h ) {
                h.classList.toggle( HEADER_DARK_CLASS, dark );
            } );
        }
        paint( document );
        document.querySelectorAll( 'iframe' ).forEach( function ( f ) {
            try { paint( f.contentDocument ); } catch ( e ) {}
        } );
    }

    function setDarkMode( enabled ) {
        try {
            window.localStorage.setItem( STORAGE_KEY, enabled ? '1' : '0' );
        } catch ( e ) {}
        applyThemeToAll( enabled ? DARK_THEME : LIGHT_THEME );
        applyHeaderTheme();
        window.dispatchEvent( new CustomEvent( DARK_EVENT, {
            detail: { enabled: !! enabled },
        } ) );
    }

    window.addEventListener( 'storage', function ( e ) {
        if ( e.key !== STORAGE_KEY ) return;
        const enabled = e.newValue === '1';
        applyThemeToAll( enabled ? DARK_THEME : LIGHT_THEME );
        applyHeaderTheme();
        window.dispatchEvent( new CustomEvent( DARK_EVENT, {
            detail: { enabled: enabled },
        } ) );
    } );

    // WP 7.0 moved Custom HTML editing into a fullscreen Modal that, once
    // open, overlays the canvas and hides the block toolbar — so the
    // dark-mode button on the toolbar is unreachable mid-edit. We mirror
    // that toggle into the modal's header (next to the native fullscreen
    // button) so it's available from inside the modal too. Pre-7.0 has no
    // modal, so injection is a no-op there.
    const MODAL_HEADER_SEL     = '.block-library-html__modal-header';
    const MODAL_DARK_BTN_CLASS = 'chsh-modal-dark-toggle';

    // WP 7.0's modal splits its body between the code editor
    // (.block-library-html__modal-content) and a live preview pane
    // (.block-library-html__preview), each `flex: 1`, so the code never
    // gets more than half the width — even in the modal's own fullscreen
    // mode. We inject a second header button that hides the preview pane
    // (via the `chsh-hide-preview` class on <body>, see editor.css);
    // with the preview gone the editor's `flex: 1` lets it fill the modal
    // edge to edge. The preference is persisted like dark mode so it
    // sticks across blocks and sessions.
    const MODAL_SEL                = '.block-library-html__modal';
    const MODAL_CONTENT_SEL        = '.block-library-html__modal-content';
    const MODAL_PREVIEW_BTN_CLASS  = 'chsh-modal-preview-toggle';
    const HIDE_PREVIEW_CLASS       = 'chsh-hide-preview';
    const PREVIEW_STORAGE_KEY      = 'chsh:hidePreview';

    // Click-outside-to-close. WP 7.0's modal sets
    // shouldCloseOnClickOutside={false}, so clicking the dimmer that
    // surrounds the (non-fullscreen) frame does nothing. Re-enable it: a
    // click on the overlay itself closes the editor. The dimmer is a large,
    // empty region the cursor never works in, so an accidental close is
    // implausible.
    //
    // The modal stages edits locally and only commits them when the
    // footer's "Update" (primary) button runs; onRequestClose — what Cancel
    // and Esc invoke — DISCARDS them. We deliberately mirror Cancel: a
    // dimmer click discards, matching the user's flow of always clicking
    // "Update" explicitly after meaningful edits. We click the footer's
    // Cancel (tertiary) button rather than dispatching Esc so the close
    // path is identical to the native control.
    const MODAL_OVERLAY_CLASS  = 'components-modal__screen-overlay';
    const MODAL_OVERLAY_SEL    = '.' + MODAL_OVERLAY_CLASS;
    const MODAL_CANCEL_BTN_SEL =
        '.block-library-html__modal-footer .components-button.is-tertiary';
    const overlaysWired = new WeakSet();

    function wireOverlayDismiss( header ) {
        const modal = header && header.closest
            ? header.closest( MODAL_SEL )
            : null;
        if ( ! modal || ! modal.closest ) return;
        const overlay = modal.closest( MODAL_OVERLAY_SEL );
        if ( ! overlay || overlaysWired.has( overlay ) ) return;
        overlaysWired.add( overlay );
        overlay.addEventListener( 'click', function ( e ) {
            // Only a click landing on the dimmer itself closes — clicks
            // inside the frame bubble up with a deeper target.
            if ( e.target !== overlay ) return;
            const cancel = overlay.querySelector( MODAL_CANCEL_BTN_SEL );
            if ( cancel ) cancel.click();
        } );
    }

    function getHidePreview() {
        try {
            return window.localStorage.getItem( PREVIEW_STORAGE_KEY ) === '1';
        } catch ( e ) {
            return false;
        }
    }

    // Paint-by-query, mirroring syncModalDarkButtons: toggle the CSS flag
    // and keep every injected button's pressed state in sync, across the
    // top doc and any iframe portals. CodeMirror caches its viewport width,
    // so nudge a refresh once the editor column has resized.
    //
    // The flag goes on each document's <body>, NOT on the modal element.
    // `.block-library-html__modal` is the React-rendered Modal frame; when
    // the user toggles the native fullscreen button, React re-renders and
    // rewrites that element's className (adding `is-full-screen`), which
    // strips any class we added imperatively — the preview pane snaps back
    // and the editor returns to half width until the next manual toggle.
    // <body> sits outside the editor's React root, so React never rewrites
    // it and the full-width state survives a fullscreen toggle.
    function applyHidePreview() {
        const hide = getHidePreview();
        function paint( doc ) {
            if ( ! doc || ! doc.querySelectorAll ) return;
            if ( doc.body ) {
                doc.body.classList.toggle( HIDE_PREVIEW_CLASS, hide );
            }
            doc.querySelectorAll(
                '.' + MODAL_PREVIEW_BTN_CLASS
            ).forEach( function ( btn ) {
                btn.setAttribute( 'aria-pressed', hide ? 'true' : 'false' );
                btn.classList.toggle( 'is-pressed', hide );
                btn.setAttribute(
                    'aria-label',
                    hide ? 'Show preview' : 'Hide preview'
                );
            } );
        }
        paint( document );
        document.querySelectorAll( 'iframe' ).forEach( function ( f ) {
            try { paint( f.contentDocument ); } catch ( e ) {}
        } );
        requestAnimationFrame( function () {
            for ( let i = cmInstances.length - 1; i >= 0; i-- ) {
                try { cmInstances[ i ].refresh(); } catch ( e ) {}
            }
        } );
    }

    function setHidePreview( hide ) {
        try {
            window.localStorage.setItem(
                PREVIEW_STORAGE_KEY, hide ? '1' : '0'
            );
        } catch ( e ) {}
        applyHidePreview();
    }

    window.addEventListener( 'storage', function ( e ) {
        if ( e.key === PREVIEW_STORAGE_KEY ) applyHidePreview();
    } );

    // Single global sync function (paint-by-query) instead of a listener
    // per injected button — keeps cleanup trivial when the modal closes
    // and the button is GC'd along with the rest of the modal DOM.
    function syncModalDarkButtons() {
        const dark = getDarkMode();
        function paint( doc ) {
            if ( ! doc || ! doc.querySelectorAll ) return;
            doc.querySelectorAll(
                '.' + MODAL_DARK_BTN_CLASS
            ).forEach( function ( btn ) {
                btn.setAttribute(
                    'aria-pressed',
                    dark ? 'true' : 'false'
                );
                btn.classList.toggle( 'is-pressed', dark );
                btn.setAttribute(
                    'aria-label',
                    dark
                        ? 'Switch to light mode'
                        : 'Switch to dark mode'
                );
            } );
        }
        paint( document );
        document.querySelectorAll( 'iframe' ).forEach( function ( f ) {
            try { paint( f.contentDocument ); } catch ( e ) {}
        } );
    }

    function injectModalDarkToggle( header ) {
        if ( ! header || header.querySelector( '.' + MODAL_DARK_BTN_CLASS ) ) {
            return;
        }
        const doc = header.ownerDocument;
        const btn = doc.createElement( 'button' );
        btn.type = 'button';
        // Mimic the native fullscreen Button's variant="tertiary"
        // icon-button classes so the toggle inherits modal styling
        // without us shipping our own CSS for it.
        btn.className =
            'components-button has-icon is-tertiary '
            + MODAL_DARK_BTN_CLASS;
        btn.innerHTML =
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" ' +
            'width="24" height="24" aria-hidden="true" focusable="false">' +
            '<path fill="currentColor" ' +
            'd="M12 3a9 9 0 1 0 9 9 7 7 0 0 1-9-9z"/></svg>';
        btn.addEventListener( 'click', function () {
            setDarkMode( ! getDarkMode() );
        } );

        // The header is an HStack[justify=space-between] with a left
        // slot (tab list) and — on non-mobile — a right slot holding
        // the fullscreen button. Land in the right slot when present;
        // otherwise create one so flex layout pushes us to the edge.
        let rightSlot = header.lastElementChild;
        if ( ! rightSlot || rightSlot === header.firstElementChild ) {
            rightSlot = doc.createElement( 'div' );
            header.appendChild( rightSlot );
        }
        rightSlot.insertBefore( btn, rightSlot.firstChild );

        syncModalDarkButtons();
    }

    function injectModalPreviewToggle( header ) {
        if (
            ! header ||
            header.querySelector( '.' + MODAL_PREVIEW_BTN_CLASS )
        ) {
            return;
        }
        const doc = header.ownerDocument;
        const btn = doc.createElement( 'button' );
        btn.type = 'button';
        btn.className =
            'components-button has-icon is-tertiary '
            + MODAL_PREVIEW_BTN_CLASS;
        // A panel split with the right pane shaded — the conventional
        // "toggle the side preview" affordance.
        btn.innerHTML =
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" ' +
            'width="24" height="24" aria-hidden="true" focusable="false">' +
            '<rect x="4" y="5" width="16" height="14" rx="1" fill="none" ' +
            'stroke="currentColor" stroke-width="1.6"/>' +
            '<rect x="14" y="5" width="6" height="14" ' +
            'fill="currentColor" opacity="0.7"/></svg>';
        btn.addEventListener( 'click', function () {
            setHidePreview( ! getHidePreview() );
        } );

        // Match injectModalDarkToggle: land in the header's right slot so
        // both toggles sit beside the native fullscreen button.
        let rightSlot = header.lastElementChild;
        if ( ! rightSlot || rightSlot === header.firstElementChild ) {
            rightSlot = doc.createElement( 'div' );
            header.appendChild( rightSlot );
        }
        rightSlot.insertBefore( btn, rightSlot.firstChild );

        applyHidePreview();
    }

    // CodeMirror 5 caches its viewport width and does NOT reflow when its
    // container resizes — there is no built-in resize handling. Several
    // things resize the editor without touching its DOM, leaving the code
    // boxed at the old (usually half) width until something calls refresh():
    //   - the modal's native full-size button,
    //   - hiding the preview pane (our full-width toggle): the editor column
    //     `.block-library-html__modal-content` is `flex: 1` and widens to
    //     fill the space the now-`display:none` preview vacated,
    //   - the sidebar/window resizing.
    //
    // We must observe the editor *column*, not the modal: hiding the preview
    // changes only the column's width, never the modal's, so a modal-level
    // observer never fires for it — which is exactly why the persisted
    // full-width state failed to take on open and only a manual toggle (which
    // happens to refresh) fixed it. The column box changes for fullscreen too
    // (it's a flex child of the modal), so one observer here covers every
    // case. refresh() doesn't alter the column's own size, so no resize loop.
    // The WeakSet prevents double-observing and lets the observer be collected
    // when the modal is torn down.
    const observedColumns = new WeakSet();

    function watchModalResize( header ) {
        if ( typeof window.ResizeObserver !== 'function' || ! header ) return;
        const modal = header.closest ? header.closest( MODAL_SEL ) : null;
        const column = modal
            ? modal.querySelector( MODAL_CONTENT_SEL )
            : null;
        const target = column || modal;
        if ( ! target || observedColumns.has( target ) ) return;
        observedColumns.add( target );
        const ro = new window.ResizeObserver( function () {
            requestAnimationFrame( function () {
                for ( let i = cmInstances.length - 1; i >= 0; i-- ) {
                    try { cmInstances[ i ].refresh(); } catch ( e ) {}
                }
            } );
        } );
        ro.observe( target );
    }

    function injectModalHeaderButtons( header ) {
        injectModalDarkToggle( header );
        injectModalPreviewToggle( header );
        watchModalResize( header );
        wireOverlayDismiss( header );
    }

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

    const DEFAULT_TITLE = 'Custom HTML';

    function setExpanded( clientId, expanded, title ) {
        if ( expanded ) {
            expandedBlocks.add( clientId );
        } else {
            expandedBlocks.delete( clientId );
        }
        const wrappers = findCmWrappersForBlock( clientId );
        wrappers.forEach( function ( wrapper ) {
            wrapper.classList.toggle( EXPANDED_CLASS, !! expanded );
            if ( expanded ) {
                ensureHeader( wrapper, clientId, title );
            } else {
                removeHeader( wrapper );
            }
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

    // Update the header title for an already-expanded block so a rename
    // performed via the inspector reflects in the pop-out without having
    // to close and reopen.
    function setHeaderTitle( clientId, title ) {
        if ( ! expandedBlocks.has( clientId ) ) return;
        findCmWrappersForBlock( clientId ).forEach( function ( wrapper ) {
            const header = headerFor( wrapper );
            if ( ! header ) return;
            const t = header.querySelector( '.' + HEADER_CLASS + '__title' );
            if ( t ) t.textContent = title || DEFAULT_TITLE;
        } );
    }

    // The pop-out header is a sibling element inserted just before the
    // CodeMirror wrapper in the same document — important because the
    // wrapper may live inside the editor canvas iframe, and a header in a
    // different document couldn't share `position: fixed` coordinates.
    function ensureHeader( wrapper, clientId, title ) {
        const prev = wrapper.previousElementSibling;
        if ( prev && prev.classList && prev.classList.contains( HEADER_CLASS ) ) {
            const t = prev.querySelector( '.' + HEADER_CLASS + '__title' );
            if ( t ) t.textContent = title || DEFAULT_TITLE;
            return prev;
        }
        const doc    = wrapper.ownerDocument;
        const header = doc.createElement( 'div' );
        header.className = HEADER_CLASS;
        if ( getDarkMode() ) header.classList.add( HEADER_DARK_CLASS );

        const titleEl = doc.createElement( 'span' );
        titleEl.className   = HEADER_CLASS + '__title';
        titleEl.textContent = title || DEFAULT_TITLE;

        const close = doc.createElement( 'button' );
        close.type      = 'button';
        close.className = HEADER_CLASS + '__close';
        close.setAttribute( 'aria-label', 'Collapse editor' );
        close.title     = 'Collapse editor (Esc)';
        // Inline SVG so it renders identically in iframe and top docs
        // without depending on an external icon font. Drawn as two thick
        // stroked diagonals (3px @ 24-unit viewBox, with rounded caps) so
        // the X reads as a deliberate close button rather than a thin
        // text glyph.
        close.innerHTML =
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" ' +
            'width="18" height="18" aria-hidden="true" focusable="false">' +
            '<path fill="none" stroke="currentColor" stroke-width="3" ' +
            'stroke-linecap="round" d="M6 6 L18 18 M18 6 L6 18"/></svg>';
        close.addEventListener( 'click', function () {
            setExpanded( clientId, false );
        } );

        header.appendChild( titleEl );
        header.appendChild( close );
        wrapper.parentNode.insertBefore( header, wrapper );
        return header;
    }

    function removeHeader( wrapper ) {
        const prev = wrapper.previousElementSibling;
        if ( prev && prev.classList && prev.classList.contains( HEADER_CLASS ) ) {
            prev.remove();
        }
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

    function headerFor( wrapper ) {
        const prev = wrapper.previousElementSibling;
        if ( prev && prev.classList && prev.classList.contains( HEADER_CLASS ) ) {
            return prev;
        }
        return null;
    }

    function applyExpandedBounds( wrapper ) {
        const expanded = wrapper.classList.contains( EXPANDED_CLASS );
        const style    = wrapper.style;
        const header   = headerFor( wrapper );
        if ( ! expanded ) {
            clearBoundsStyles( style );
            if ( header ) clearBoundsStyles( header.style );
            return;
        }
        // Iframe doc: defer to the CSS rules. The expanded selector and
        // the header selector both pin to `position: fixed` against the
        // iframe viewport (which excludes the WP chrome), and stack
        // header on top of editor without inline coords.
        if ( wrapper.ownerDocument !== document ) {
            clearBoundsStyles( style );
            if ( header ) clearBoundsStyles( header.style );
            return;
        }
        const rect = findCanvasRect();
        if ( ! rect ) {
            clearBoundsStyles( style );
            if ( header ) clearBoundsStyles( header.style );
            return;
        }
        // Inline width/height + auto right/bottom take priority over the
        // stylesheet's `inset` rules so the overlay fits the canvas
        // region and not the whole window. The header sits above the
        // wrapper and shares the same horizontal coords; the wrapper
        // starts HEADER_HEIGHT below the header's top.
        const top    = rect.top + EDGE_INSET;
        const left   = rect.left + EDGE_INSET;
        const width  = Math.max( 0, rect.width  - EDGE_INSET * 2 );
        const height = Math.max( 0, rect.height - EDGE_INSET * 2 );

        if ( header ) {
            const hs = header.style;
            hs.top    = top + 'px';
            hs.left   = left + 'px';
            hs.right  = 'auto';
            hs.bottom = 'auto';
            hs.width  = width + 'px';
            hs.height = HEADER_HEIGHT + 'px';
        }

        style.top    = ( top + HEADER_HEIGHT ) + 'px';
        style.left   = left + 'px';
        style.right  = 'auto';
        style.bottom = 'auto';
        style.width  = width + 'px';
        style.height = Math.max( 0, height - HEADER_HEIGHT ) + 'px';
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

    // Trap Tab inside the editor. CodeMirror's own extraKeys.Tab fires
    // and calls preventDefault, but Gutenberg's writing-flow tab nav
    // listens on an ancestor and moves focus programmatically via
    // .focus() — which ignores preventDefault. We intercept Tab in the
    // capture phase at the document level (before it reaches Gutenberg's
    // bubble-phase listener) when the target is inside a CodeMirror,
    // stop propagation entirely, and run the indent ourselves.
    function tabHandler( e ) {
        if ( e.key !== 'Tab' || e.ctrlKey || e.altKey || e.metaKey ) return;
        const target = e.target;
        if ( ! target || typeof target.closest !== 'function' ) return;
        const wrapper = target.closest( '.CodeMirror' );
        if ( ! wrapper || ! wrapper.CodeMirror ) return;
        const cm = wrapper.CodeMirror;
        e.preventDefault();
        e.stopPropagation();
        if ( e.stopImmediatePropagation ) e.stopImmediatePropagation();
        if ( e.shiftKey ) {
            cm.indentSelection( 'subtract' );
        } else if ( cm.somethingSelected() ) {
            cm.indentSelection( 'add' );
        } else {
            cm.replaceSelection(
                ' '.repeat( settingsTabSize() ),
                'end'
            );
        }
    }
    document.addEventListener( 'keydown', tabHandler, true );

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

        // Disable mode-driven auto-indent. CodeMirror's CSS mode (used by
        // htmlmixed inside `<style>`) computes indent relative to the
        // column of the `<style>` tag, which can balloon to 20+ spaces
        // when the surrounding HTML is itself indented. With smartIndent
        // off and our own Enter handler (below) that just copies the
        // previous line's leading whitespace, indentation becomes
        // predictable and stays at whatever the user typed. electricChars
        // off prevents typing `}` from triggering a re-indent of the
        // current line for the same reason.
        cm.smartIndent   = false;
        cm.electricChars = false;

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

        // Tab/Shift-Tab are handled by a capture-phase document listener
        // (see tabHandler) so Gutenberg's writing-flow tab navigation
        // can't steal them — preventDefault alone isn't enough because
        // Gutenberg moves focus programmatically via .focus(), which
        // ignores preventDefault. Enter is overridden to just copy the
        // previous line's leading whitespace; combined with smartIndent
        // off, this stops the CSS mode from producing 20+ space indents.
        cm.setOption( 'extraKeys', {
            Enter: function ( editor ) {
                if ( editor.somethingSelected() ) {
                    editor.replaceSelection( '\n' );
                    return;
                }
                const cursor   = editor.getCursor();
                const lineText = editor.getLine( cursor.line ) || '';
                const leading  = ( lineText.match( /^[ \t]*/ ) || [ '' ] )[ 0 ];
                editor.replaceSelection( '\n' + leading );
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

        // Re-assert the persisted hide-preview ("full width") state now
        // that this instance is registered. On a fresh modal open, the
        // header's injectModalPreviewToggle() already ran applyHidePreview()
        // — but the tab's <textarea> is mounted in a later React commit, so
        // this editor attaches *after* that refresh fired and never gets the
        // post-hide resize. The result: the toggle reads as pressed but the
        // editor still renders at the preview-split (half) width until the
        // user toggles it off and on. Calling applyHidePreview() here
        // re-applies the modal class and schedules a refresh that includes
        // this instance, so the saved full-width state takes effect on open.
        if ( isWp70Plus ) {
            applyHidePreview();
        }
    }

    function scan( root ) {
        if ( ! root || ! root.querySelectorAll ) return;
        root.querySelectorAll( SELECTOR ).forEach( attachEditor );
        if ( isWp70Plus ) {
            root.querySelectorAll( MODAL_HEADER_SEL )
                .forEach( injectModalHeaderButtons );
        }
    }

    // WP 7.0's modal renders each HTML/CSS/JS tab's PlainText into a
    // persistent modal body and unmounts it on tab switch. React only
    // removes the <textarea> *it* created; the `.CodeMirror` wrapper that
    // fromTextArea() inserted as a sibling is not tracked by React, so it
    // is left orphaned in the modal body. Returning to the tab mounts a
    // fresh textarea (new element, not in our `initialized` set), we attach
    // a new CodeMirror, and the stale wrapper remains beneath it — that's
    // the "editors stack on every tab switch" symptom. Sweep on each
    // mutation batch and tear down any instance whose backing textarea has
    // left the DOM (or whose wrapper is already gone), keeping cmInstances
    // and the live DOM in sync.
    function cleanupDetachedEditors() {
        for ( let i = cmInstances.length - 1; i >= 0; i-- ) {
            const cm = cmInstances[ i ];
            let wrapper = null;
            let ta      = null;
            try { wrapper = cm.getWrapperElement(); } catch ( e ) {}
            try { ta = cm.getTextArea(); } catch ( e ) {}

            if ( ! wrapper || ! wrapper.isConnected ) {
                // CodeMirror's own DOM is already gone; just forget it.
                cmInstances.splice( i, 1 );
                continue;
            }
            if ( ! ta || ! ta.isConnected ) {
                // Backing textarea was unmounted but the wrapper lingers.
                // toTextArea() removes the wrapper and restores the (now
                // detached, harmless) textarea; fall back to a manual
                // detach if it throws.
                try {
                    cm.toTextArea();
                } catch ( e ) {
                    if ( wrapper.parentNode ) {
                        wrapper.parentNode.removeChild( wrapper );
                    }
                }
                cmInstances.splice( i, 1 );
            }
        }
    }

    function watchDoc( doc ) {
        if ( ! doc || ! doc.body || watchedDocs.has( doc ) ) return;
        watchedDocs.add( doc );
        log( 'watching document', doc === document ? '(top)' : '(iframe)' );
        scan( doc );
        if ( doc !== document ) {
            doc.addEventListener( 'keydown', escHandler, true );
            doc.addEventListener( 'keydown', tabHandler, true );
        }

        const Observer =
            ( doc.defaultView && doc.defaultView.MutationObserver ) ||
            window.MutationObserver;

        new Observer( function ( mutations ) {
            // A tab switch removes the old tab's textarea (and may add the
            // new tab's in the same batch). Reap orphaned wrappers first so
            // returning to a tab never stacks a second editor.
            cleanupDetachedEditors();
            for ( let i = 0; i < mutations.length; i++ ) {
                const added = mutations[ i ].addedNodes;
                for ( let j = 0; j < added.length; j++ ) {
                    const node = added[ j ];
                    if ( node.nodeType !== 1 ) continue;
                    if ( node.matches ) {
                        if ( node.matches( SELECTOR ) ) {
                            attachEditor( node );
                        }
                        if ( isWp70Plus && node.matches( MODAL_HEADER_SEL ) ) {
                            injectModalHeaderButtons( node );
                        }
                    }
                    scan( node );
                }
            }
        } ).observe( doc.body, { childList: true, subtree: true } );
    }

    // Keep injected modal-header toggles in sync with global dark-mode
    // state — listening on DARK_EVENT covers both the toolbar-button
    // path (setDarkMode) and the cross-tab path (storage event handler).
    window.addEventListener( DARK_EVENT, syncModalDarkButtons );

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

                    // The user can rename a block via the inspector
                    // ("Block Name"); that lives at attributes.metadata.name.
                    // Fall back to "Custom HTML" when it isn't set.
                    const blockName = (
                        props.attributes &&
                        props.attributes.metadata &&
                        props.attributes.metadata.name
                    ) || '';

                    // Live-update the popped-out header when the user
                    // renames the block while it's expanded.
                    useEffect( function () {
                        if ( expandedBlocks.has( props.clientId ) ) {
                            setHeaderTitle( props.clientId, blockName );
                        }
                    }, [ props.clientId, blockName ] );

                    // WP 7.0's modal already provides its own fullscreen
                    // toggle, and our pop-out finds editors via
                    // `[data-block="<clientId>"] .CodeMirror` — which won't
                    // reach the portal-mounted modal anyway. Drop the
                    // expand button on 7.0+ so the toolbar doesn't show a
                    // control that has nothing to act on.
                    const expandButton = isWp70Plus ? null : el( ToolbarButton, {
                        icon:      expanded ? collapseIcon : expandIcon,
                        label:     expanded
                            ? __( 'Collapse editor', 'chsh' )
                            : __( 'Expand editor', 'chsh' ),
                        isPressed: expanded,
                        onClick:   function () {
                            setExpanded(
                                props.clientId,
                                ! expanded,
                                blockName
                            );
                        },
                    } );

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
                                expandButton,
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
