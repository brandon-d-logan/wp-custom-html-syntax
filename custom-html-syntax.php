<?php
/**
 * Plugin Name:       Custom HTML Syntax Highlighter
 * Description:       Adds CodeMirror syntax highlighting to the Custom HTML
 *                    block — using WP's own bundled CodeMirror. No CDN needed.
 * Version:           1.1.0
 * Requires at least: 6.0
 * Requires PHP:      7.4
 * License:           License to Kill
 */

defined( 'ABSPATH' ) || exit;

define( 'CHSH_VERSION', '1.1.0' );

add_action( 'enqueue_block_editor_assets', 'chsh_enqueue_editor_assets' );

function chsh_enqueue_editor_assets() {

    // ── Core CodeMirror (bundled in WP since 4.9) ────────────────────────────
    // wp_enqueue_code_editor() registers wp-codemirror, the code-editor style,
    // and prints the requested htmlmixed mode + standard addons (including
    // matchbrackets / closebrackets) inline. The individual mode/addon script
    // handles ("codemirror-mode-htmlmixed", etc.) are NOT registered in core,
    // so depending on them silently prevents our editor.js from enqueuing.
    wp_enqueue_code_editor( array( 'type' => 'text/html' ) );

    // ── Our files ────────────────────────────────────────────────────────────
    wp_enqueue_script(
        'chsh-editor',
        plugin_dir_url( __FILE__ ) . 'editor.js',
        array(
            'wp-codemirror',
            'wp-hooks',
            'wp-compose',
            'wp-element',
        ),
        CHSH_VERSION,
        true
    );

    wp_enqueue_style(
        'chsh-editor',
        plugin_dir_url( __FILE__ ) . 'editor.css',
        array( 'code-editor' ),
        CHSH_VERSION
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
