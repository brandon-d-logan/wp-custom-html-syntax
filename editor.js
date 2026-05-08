/* global CodeMirror, chshSettings, wp */
/**
 * Adds CodeMirror syntax highlighting to the core/html (Custom HTML) block.
 *
 * Uses the documented Gutenberg extensibility API:
 *   - `editor.BlockEdit` filter to wrap the block's edit component with an HOC
 *   - `wp.element` (React) effects to locate the rendered textarea
 *
 * The HOC renders the original BlockEdit *unchanged* — no wrapping element —
 * then uses a useEffect to find this block's wrapper via its `data-block`
 * attribute (set by Gutenberg on every block in the canvas) and attaches
 * CodeMirror to the textarea inside it. Wrapping BlockEdit in extra DOM can
 * trip up some core blocks' layout / error boundaries, so we avoid it.
 *
 * See:
 *   https://developer.wordpress.org/block-editor/reference-guides/filters/block-filters/#editor-blockedit
 */
( function () {
    'use strict';

    if ( typeof CodeMirror === 'undefined' ) {
        return;
    }

    const { addFilter }                  = wp.hooks;
    const { createHigherOrderComponent } = wp.compose;
    const { createElement, useEffect }   = wp.element;

    const initialized = new WeakSet();

    function attachEditor( textarea ) {
        if ( ! textarea || initialized.has( textarea ) ) return;
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
                'Shift-Tab': function ( editor ) {
                    editor.indentSelection( 'subtract' );
                },
            },
        } );

        // Push CodeMirror edits back into the React-controlled <textarea> so
        // Gutenberg's onChange fires and the block's saved markup updates.
        const win = textarea.ownerDocument.defaultView || window;
        const nativeSetter = Object.getOwnPropertyDescriptor(
            win.HTMLTextAreaElement.prototype,
            'value'
        ).set;

        cm.on( 'change', function () {
            nativeSetter.call( textarea, cm.getValue() );
            textarea.dispatchEvent( new Event( 'input', { bubbles: true } ) );
        } );

        cm.on( 'focus', function () {
            cm.refresh();
        } );
    }

    // Search the main document and any same-origin iframes (forward-compat
    // for an iframe'd canvas) for a block wrapper with this clientId.
    function findBlockWrapper( clientId ) {
        const selector = '[data-block="' + clientId + '"]';
        const main = document.querySelector( selector );
        if ( main ) return main;

        const iframes = document.querySelectorAll( 'iframe' );
        for ( let i = 0; i < iframes.length; i++ ) {
            let doc;
            try { doc = iframes[ i ].contentDocument; } catch ( e ) { continue; }
            if ( ! doc ) continue;
            const found = doc.querySelector( selector );
            if ( found ) return found;
        }
        return null;
    }

    const withCodeMirror = createHigherOrderComponent( function ( BlockEdit ) {
        return function ( props ) {
            // Hooks must be called unconditionally; gate work inside the effect.
            useEffect( function () {
                if ( props.name !== 'core/html' || ! props.clientId ) return;

                let observer = null;
                let cancelled = false;

                const tryAttach = function () {
                    const wrapper = findBlockWrapper( props.clientId );
                    if ( ! wrapper ) return false;
                    const ta = wrapper.querySelector( 'textarea' );
                    if ( ta ) attachEditor( ta );

                    if ( ! observer ) {
                        const Win = wrapper.ownerDocument.defaultView || window;
                        observer = new Win.MutationObserver( function () {
                            const t = wrapper.querySelector( 'textarea' );
                            if ( t ) attachEditor( t );
                        } );
                        observer.observe( wrapper, {
                            childList: true,
                            subtree:   true,
                        } );
                    }
                    return true;
                };

                if ( ! tryAttach() ) {
                    // The block wrapper may not be in the DOM on the same tick
                    // the effect fires; retry on the next animation frame.
                    const raf = function () {
                        if ( cancelled ) return;
                        if ( ! tryAttach() ) {
                            requestAnimationFrame( raf );
                        }
                    };
                    requestAnimationFrame( raf );
                }

                return function () {
                    cancelled = true;
                    if ( observer ) observer.disconnect();
                };
            }, [ props.clientId, props.name ] );

            return createElement( BlockEdit, props );
        };
    }, 'withCodeMirrorHTML' );

    addFilter(
        'editor.BlockEdit',
        'chsh/with-codemirror-html',
        withCodeMirror
    );
} )();
