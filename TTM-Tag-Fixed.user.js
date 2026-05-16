// ==UserScript==
// @name         Tieuthuyetmang Tag Fixer (SPA Compatible)
// @namespace    https://tieuthuyetmang.com/
// @version      1.3
// @description  Fixes clickable tags for dynamic navigation
// @author       Assistant
// @match        https://tieuthuyetmang.com/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    // 1. Improved Slug Logic
    function toSlug(str) {
        if (!str) return '';
        return str.toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/[đĐ]/g, 'd')
            .replace(/([^0-9a-z-\s])/g, '')
            .replace(/(\s+)/g, '-')
            .replace(/-+/g, '-')
            .replace(/^-+|-+$/g, '');
    }

    const ignoreTags = ['đang ra', 'hoàn thành', 'tạm ngưng'];

    // 2. Inject Styles Globally (Ensure they persist)
    const injectStyles = () => {
        if (document.getElementById('scriptcat-tag-styles')) return;
        const style = document.createElement('style');
        style.id = 'scriptcat-tag-styles';
        style.innerHTML = `
            /* Targets spans in the story info area */
            .flex.flex-wrap span.rounded-full {
                cursor: pointer !important;
                pointer-events: auto !important;
                transition: background-color 0.2s !important;
            }
            .flex.flex-wrap span.rounded-full:hover {
                filter: brightness(0.8);
                text-decoration: underline;
            }
        `;
        document.head.appendChild(style);
    };

    // 3. Main Click Handler
    const handleTagClick = (e) => {
        // Find if the clicked element (or its parent) is one of our tags
        const tag = e.target.closest('span.rounded-full');
        
        if (tag) {
            const text = tag.textContent.trim();
            if (ignoreTags.includes(text.toLowerCase())) return;

            // Stop the site's own scripts from potentially blocking this
            e.preventDefault();
            e.stopPropagation();

            const slug = toSlug(text);
            
            // Build a fresh URL to prevent "sticking" to old categories
            const newUrl = new URL('https://tieuthuyetmang.com/truyen');
            newUrl.searchParams.set('has_audio', '1');
            newUrl.searchParams.set('sort', 'new');
            newUrl.searchParams.set('category', slug);

            console.log(`Navigating to: ${newUrl.href}`);
            window.location.href = newUrl.href;
        }
    };

    // 4. Initialization & Maintenance
    injectStyles();
    
    // Use "Capture" phase (true) to ensure we catch the click before the site's SPA router
    document.addEventListener('click', handleTagClick, true);

    // Re-inject styles if the site clears the head (common in some frameworks)
    const observer = new MutationObserver(() => injectStyles());
    observer.observe(document.head, { childList: true });

    console.log("ScriptCat: Tag Fixer initialized.");
})();
