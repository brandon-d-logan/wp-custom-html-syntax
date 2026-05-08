/* global CodeMirror, chshSettings, wp */
( function () {
    'use strict';

    if ( typeof CodeMirror === 'undefined' ) {
        return; // Safety guard — should never happen on WP 6+
    }

    // Track which textareas we've already enhanced
    const initialized = new WeakSet();

    function attachEditor( textarea ) {
        if ( initialized.has( textarea ) ) return;
        initialized.add( textarea );

        const cm = CodeMirror.fromTextArea( textarea, {
            mode:              'htmlmixed',
            theme:             chshSettings.theme || 'default',
            lineNumbers:       true,
            lineWrapping:      true,
            indentUnit:        chshSettings.tabSize || 2,
            tabSize:           chshSettings.tabSize || 2,
            indentWithTabs:    false,
            matchBrackets:     true,
            autoCloseBrackets: true,
            extraKeys: {
                // Tab inserts spaces instead of a tab character
                Tab: function ( editor ) {
                    if ( editor.somethingSelected() ) {
                        editor.indentSelection( 'add' );
                    } else {
                        editor.replaceSelection(
                            ' '.repeat( chshSettings.tabSize || 2 ),
                            'end'
                        );
                    }
                },
                // Shift-Tab dedents
                'Shift-Tab': function ( editor ) {
                    editor.indentSelection( 'subtract' );
                },
            },
        } );

        // ── Sync CodeMirror → React ──────────────────────────────────────────
        // React uses synthetic events. To trigger its onChange we must use the
        // native HTMLTextAreaElement value setter, then dispatch an 'input'
        // event so React's SyntheticEvent layer picks it up.
        const nativeSetter = Object.getOwnPropertyDescriptor(
            HTMLTextAreaElement.prototype,
            'value'
        ).set;

        cm.on( 'change', function () {
            nativeSetter.call( textarea, cm.getValue() );
            textarea.dispatchEvent( new Event( 'input', { bubbles: true } ) );
        } );

        // Refresh after the Preview ↔ HTML tab toggle reveals the editor again
        cm.on( 'focus', function () {
            cm.refresh();
        } );

        // Refresh on window resize so line numbers stay aligned
        window.addEventListener( 'resize', function () {
            cm.refresh();
        }, { passive: true } );
    }

    const SELECTOR =
        '[data-type="core/html"] textarea, .wp-block-html textarea';

    function scanIn( doc ) {
        doc.querySelectorAll( SELECTOR ).forEach( attachEditor );
    }

    const watchedDocs = new WeakSet();
    function watchDoc( doc ) {
        if ( ! doc || ! doc.body || watchedDocs.has( doc ) ) return;
        watchedDocs.add( doc );
        scanIn( doc );
        new MutationObserver( function () {
            scanIn( doc );
        } ).observe( doc.body, { childList: true, subtree: true } );
    }

    // Since WP 6.3 the block editor canvas runs inside an iframe
    // (<iframe name="editor-canvas">), so the textareas live in a different
    // document from this script. Watch the parent doc *and* the iframe doc.
    const watchedFrames = new WeakSet();
    function watchIframes() {
        document
            .querySelectorAll(
                'iframe[name="editor-canvas"], iframe.edit-post-visual-editor__content-area, iframe.editor-canvas__iframe'
            )
            .forEach( function ( iframe ) {
                if ( watchedFrames.has( iframe ) ) return;
                watchedFrames.add( iframe );

                const tryWatch = function () {
                    watchDoc( iframe.contentDocument );
                };
                tryWatch();
                iframe.addEventListener( 'load', tryWatch );
            } );
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
