/* global CodeMirror, chshSettings, wp */
/**
 * Replaces the core/html (Custom HTML) block's edit component with a
 * CodeMirror-backed editor.
 *
 * Block API v2 contract: the edit component's outermost element must
 * receive the props returned by `useBlockProps()`, otherwise Gutenberg's
 * block wrapper machinery (selection, refs, drag-and-drop, classnames)
 * has an incomplete contract and the block error boundary trips with
 * "This block has encountered an error and cannot be previewed".
 *
 * See:
 *   https://developer.wordpress.org/block-editor/reference-guides/block-api/block-edit-save/#useblockprops
 *   https://developer.wordpress.org/block-editor/reference-guides/filters/block-filters/#editor-blockedit
 */
( function () {
    'use strict';

    if ( typeof CodeMirror === 'undefined' ) {
        // eslint-disable-next-line no-console
        console.warn( '[chsh] CodeMirror not loaded; skipping.' );
        return;
    }

    const { addFilter }                        = wp.hooks;
    const { createHigherOrderComponent }       = wp.compose;
    const { createElement, useEffect, useRef } = wp.element;
    const { useBlockProps }                    = wp.blockEditor;

    function HtmlEdit( props ) {
        const blockProps = useBlockProps();

        const { attributes, setAttributes } = props;
        const content    = ( attributes && attributes.content ) || '';
        const mountRef   = useRef( null );
        const cmRef      = useRef( null );
        const contentRef = useRef( content );

        useEffect( function () {
            if ( ! mountRef.current || cmRef.current ) return;

            let cm;
            try {
                cm = CodeMirror( mountRef.current, {
                    value:             content,
                    mode:              'htmlmixed',
                    theme:             ( window.chshSettings && chshSettings.theme ) || 'default',
                    lineNumbers:       true,
                    lineWrapping:      true,
                    indentUnit:        ( window.chshSettings && chshSettings.tabSize ) || 2,
                    tabSize:           ( window.chshSettings && chshSettings.tabSize ) || 2,
                    indentWithTabs:    false,
                    matchBrackets:     true,
                    autoCloseBrackets: true,
                    extraKeys: {
                        Tab: function ( editor ) {
                            const w = ( window.chshSettings && chshSettings.tabSize ) || 2;
                            if ( editor.somethingSelected() ) {
                                editor.indentSelection( 'add' );
                            } else {
                                editor.replaceSelection( ' '.repeat( w ), 'end' );
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

            cm.on( 'change', function () {
                const value = cm.getValue();
                contentRef.current = value;
                setAttributes( { content: value } );
            } );

            requestAnimationFrame( function () {
                if ( cmRef.current ) cmRef.current.refresh();
            } );

            cmRef.current = cm;

            return function () {
                if ( cmRef.current ) {
                    const wrapper = cmRef.current.getWrapperElement();
                    if ( wrapper && wrapper.parentNode ) {
                        wrapper.parentNode.removeChild( wrapper );
                    }
                    cmRef.current = null;
                }
            };
            // eslint-disable-next-line react-hooks/exhaustive-deps
        }, [] );

        // Sync external content changes (undo/redo, programmatic edits) into
        // CodeMirror — but skip echoes from our own onChange handler.
        useEffect( function () {
            const cm = cmRef.current;
            if ( ! cm ) return;
            if ( contentRef.current === content ) return;
            contentRef.current = content;
            const cursor = cm.getCursor();
            cm.setValue( content );
            try { cm.setCursor( cursor ); } catch ( e ) { /* noop */ }
        }, [ content ] );

        const className =
            ( ( blockProps && blockProps.className ) || '' ) +
            ' chsh-html-edit';

        return createElement(
            'div',
            Object.assign( {}, blockProps, { className: className.trim() } ),
            createElement( 'div', { ref: mountRef, className: 'chsh-cm-mount' } )
        );
    }

    const replaceHtmlEdit = createHigherOrderComponent( function ( BlockEdit ) {
        return function ( props ) {
            if ( props.name === 'core/html' ) {
                return createElement( HtmlEdit, props );
            }
            return createElement( BlockEdit, props );
        };
    }, 'withCodeMirrorHTML' );

    addFilter(
        'editor.BlockEdit',
        'chsh/with-codemirror-html',
        replaceHtmlEdit
    );
} )();
