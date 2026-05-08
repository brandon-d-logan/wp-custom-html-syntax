<?php
/**
 * Plugin Name:       Custom HTML Syntax Highlighter
 * Description:       Adds CodeMirror syntax highlighting to the Custom HTML
 *                    block — using WP's own bundled CodeMirror. No CDN needed.
 * Version:           1.7.1
 * Requires at least: 6.0
 * Requires PHP:      7.4
 * License:           License to Kill
 */

defined( 'ABSPATH' ) || exit;

define( 'CHSH_VERSION', '1.7.1' );

add_action( 'enqueue_block_editor_assets', 'chsh_enqueue_editor_assets' );

function chsh_enqueue_editor_assets() {

    // wp_enqueue_code_editor():
    //   - Enqueues `code-editor` (which depends on jquery, wp-codemirror,
    //     underscore) and the `code-editor` stylesheet.
    //   - Prints the htmlmixed mode + standard addons inline.
    //   - Returns the settings object that wp.codeEditor.initialize()
    //     expects (or `false` when the user has the
    //     `syntax_highlighting` profile pref disabled).
    //
    // Source: wp-includes/general-template.php
    $cm_settings = wp_enqueue_code_editor( array( 'type' => 'text/html' ) );

    // If the user has syntax highlighting disabled in their profile,
    // wp_enqueue_code_editor() bails. Force-enqueue the assets and
    // synthesise the settings ourselves so the highlighter still runs in
    // the block editor.
    if ( false === $cm_settings ) {
        wp_enqueue_script( 'code-editor' );
        wp_enqueue_style( 'code-editor' );
        $cm_settings = wp_get_code_editor_settings(
            array( 'type' => 'text/html' )
        );
    }

    wp_enqueue_script(
        'chsh-editor',
        plugin_dir_url( __FILE__ ) . 'editor.js',
        // `code-editor` provides wp.codeEditor.initialize and pulls in
        // wp-codemirror (which exposes wp.CodeMirror). The wp-* packages
        // back the BlockEdit HOC that injects the dark-mode toolbar
        // button on core/html blocks.
        array(
            'code-editor',
            'wp-dom-ready',
            'wp-element',
            'wp-components',
            'wp-block-editor',
            'wp-compose',
            'wp-hooks',
            'wp-i18n',
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

    wp_localize_script(
        'chsh-editor',
        'chshSettings',
        array(
            'codeEditor' => $cm_settings ? $cm_settings : new stdClass(),
            'tabSize'    => 2,
        )
    );
}
