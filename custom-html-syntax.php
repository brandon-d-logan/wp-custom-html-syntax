<?php
/**
 * Plugin Name:       Custom HTML Syntax Highlighter
 * Description:       Adds CodeMirror syntax highlighting to the Custom HTML
 *                    block — using WP's own bundled CodeMirror. No CDN needed.
 * Version:           1.0.0
 * Requires at least: 6.0
 * Requires PHP:      7.4
 * License:           License to Kill
 */

defined( 'ABSPATH' ) || exit;

add_action( 'enqueue_block_editor_assets', 'chsh_enqueue_editor_assets' );

function chsh_enqueue_editor_assets() {

    // ── Core CodeMirror (bundled in WP since 4.9) ────────────────────────────
    wp_enqueue_script( 'wp-codemirror' );

    // Language modes for htmlmixed (HTML with embedded CSS & JS)
    wp_enqueue_script( 'codemirror-mode-xml' );
    wp_enqueue_script( 'codemirror-mode-javascript' );
    wp_enqueue_script( 'codemirror-mode-css' );
    wp_enqueue_script( 'codemirror-mode-htmlmixed' );

    // Quality-of-life addons
    wp_enqueue_script( 'codemirror-addon-edit-matchbrackets' );
    wp_enqueue_script( 'codemirror-addon-edit-closebrackets' );

    // CodeMirror base CSS + WP admin overrides
    wp_enqueue_style( 'code-editor' );

    // ── Our files ────────────────────────────────────────────────────────────
    wp_enqueue_script(
        'chsh-editor',
        plugin_dir_url( __FILE__ ) . 'editor.js',
        array(
            'wp-dom-ready',
            'codemirror-mode-htmlmixed',
            'codemirror-addon-edit-closebrackets',
            'codemirror-addon-edit-matchbrackets',
        ),
        '1.0.0',
        true
    );

    wp_enqueue_style(
        'chsh-editor',
        plugin_dir_url( __FILE__ ) . 'editor.css',
        array( 'code-editor' ),
        '1.0.0'
    );

    // Config values exposed to JS as window.chshSettings
    wp_localize_script(
        'chsh-editor',
        'chshSettings',
        array(
            'tabSize' => 2,
            'theme'   => 'default',
        )
    );
}
