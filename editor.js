/* global CodeMirror, chshSettings, wp */
/**
 * Replaces the core/html (Custom HTML) block's edit component with a
 * CodeMirror-backed editor.
 *
 * Approach:
 *   - Use the documented `editor.BlockEdit` filter to *replace* the edit
 *     component for `core/html` only. Other blocks pass through untouched.
 *   - Render our own React component that owns a <div> mount point,
 *     instantiates CodeMirror inside it, and bridges value <-> attributes
 *     via the standard setAttributes(props) API.
 *
 * Why replacement (not augmentation):
 *   The default core/html edit uses <PlainText> (TextareaAutosize) which
 *   manages its own refs/DOM. Running CodeMirror.fromTextArea on that
 *   textarea fights React's reconciler and trips the block's error
 *   boundary ("This block has encountered an error..."). Replacing the
 *   edit component avoids any DOM ownership conflict.
 *
 * See:
 *   https://developer.wordpress.org/block-editor/reference-guides/filters/block-filters/#editor-blockedit
 */
( function () {
    'use strict';

    if ( typeof CodeMirror === 'undefined' ) {
        return;
    }

    const { addFilter }                        = wp.hooks;
    const { createHigherOrderComponent }       = wp.compose;
    const { createElement, useEffect, useRef } = wp.element;

    function HtmlEdit( props ) {
        const { attributes, setAttributes } = props;
        const content   = ( attributes && attributes.content ) || '';
        const mountRef  = useRef( null );
        const cmRef     = useRef( null );
        const contentRef = useRef( content );

        // Mount CodeMirror once.
        useEffect( function () {
            if ( ! mountRef.current || cmRef.current ) return;

            const cm = CodeMirror( mountRef.current, {
                value:             content,
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

            cm.on( 'change', function () {
                const value = cm.getValue();
                contentRef.current = value;
                setAttributes( { content: value } );
            } );

            // CodeMirror miscalculates layout if mounted while hidden;
            // refresh once the next paint settles.
            requestAnimationFrame( function () {
                cm.refresh();
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

        // Push external content changes (undo/redo, programmatic edits)
        // into CodeMirror — but skip echoes from our own onChange.
        useEffect( function () {
            const cm = cmRef.current;
            if ( ! cm ) return;
            if ( contentRef.current === content ) return;
            contentRef.current = content;
            const cursor = cm.getCursor();
            cm.setValue( content );
            try { cm.setCursor( cursor ); } catch ( e ) { /* out of range */ }
        }, [ content ] );

        return createElement( 'div', {
            ref:       mountRef,
            className: 'chsh-html-edit',
        } );
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
