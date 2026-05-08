/* global CodeMirror, chshSettings, wp */
/**
 * Adds CodeMirror syntax highlighting to the core/html (Custom HTML) block.
 *
 * Uses the documented Gutenberg extensibility API:
 *   - `editor.BlockEdit` filter to wrap the block's edit component with an HOC
 *   - `wp.element` (React) refs + effects to find the rendered <textarea>
 *
 * This works whether Gutenberg renders the canvas in the main document or in
 * an iframe, because React resolves refs to the actual mounted DOM node in
 * whichever document the component ends up in. No DOM polling required.
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
    const { createElement, useEffect, useRef } = wp.element;

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
        const nativeSetter = Object.getOwnPropertyDescriptor(
            textarea.ownerDocument.defaultView.HTMLTextAreaElement.prototype,
            'value'
        ).set;

        cm.on( 'change', function () {
            nativeSetter.call( textarea, cm.getValue() );
            textarea.dispatchEvent( new Event( 'input', { bubbles: true } ) );
        } );

        cm.on( 'focus', function () {
            cm.refresh();
        } );

        return cm;
    }

    const withCodeMirror = createHigherOrderComponent( function ( BlockEdit ) {
        return function ( props ) {
            if ( props.name !== 'core/html' ) {
                return createElement( BlockEdit, props );
            }

            const wrapperRef = useRef( null );

            useEffect( function () {
                if ( ! wrapperRef.current ) return;

                // The Custom HTML block toggles between "HTML" (textarea) and
                // "Preview" (rendered output). The textarea only exists in HTML
                // mode, and is unmounted/remounted when the user switches —
                // so we observe the wrapper for it appearing.
                const tryAttach = function () {
                    const ta = wrapperRef.current &&
                        wrapperRef.current.querySelector( 'textarea' );
                    if ( ta ) attachEditor( ta );
                };

                tryAttach();

                const observer = new ( wrapperRef.current.ownerDocument
                    .defaultView.MutationObserver )( tryAttach );
                observer.observe( wrapperRef.current, {
                    childList: true,
                    subtree:   true,
                } );

                return function () {
                    observer.disconnect();
                };
            }, [ props.clientId, props.attributes && props.attributes.content ] );

            return createElement(
                'div',
                { ref: wrapperRef, className: 'chsh-html-wrapper' },
                createElement( BlockEdit, props )
            );
        };
    }, 'withCodeMirrorHTML' );

    addFilter(
        'editor.BlockEdit',
        'chsh/with-codemirror-html',
        withCodeMirror
    );
} )();
