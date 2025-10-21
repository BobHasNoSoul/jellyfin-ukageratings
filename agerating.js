(function () {
    const overlayClass = 'age-rating-overlay';
    const CACHE_VERSION = 'v1';
    const CACHE_KEY = `ageRatingOverlayCache-${CACHE_VERSION}`;
    
    const IGNORE_SELECTORS = [
        'html.preload.layout-desktop body.force-scroll.libraryDocument div#reactRoot div.mainAnimatedPages.skinBody div#itemDetailPage.page.libraryPage.itemDetailPage.noSecondaryNavPage.selfBackdropPage.mainAnimatedPage div.detailPageWrapperContainer div.detailPageSecondaryContainer.padded-bottom-page div.detailPageContent div#castCollapsible.verticalSection.detailVerticalSection.emby-scroller-container a.cardImageContainer',
        'html.preload.layout-desktop body.force-scroll.libraryDocument.withSectionTabs.mouseIdle div#reactRoot div.mainAnimatedPages.skinBody div#indexPage.page.homePage.libraryPage.allLibraryPage.backdropPage.pageWithAbsoluteTabs.withTabs.mainAnimatedPage div#homeTab.tabContent.pageTabContent.is-active div.sections.homeSectionsContainer div.verticalSection.MyMedia.emby-scroller-container a.cardImageContainer'
    ];
    
    const MEDIA_TYPES = new Set(['Movie', 'Episode', 'Series', 'Season']);
    
    let ageRatingOverlayCache = JSON.parse(localStorage.getItem(CACHE_KEY)) || {};
    let seenItems = new Set();
    let pendingRequests = new Set();
    let errorCount = 0;
    let currentDelay = 1000;

    const iconSize = {
        width: '1.8vw',
        height: 'auto'
    };

    const config = {
        MAX_CONCURRENT_REQUESTS: 9,
        BASE_DELAY: 1000,
        MAX_DELAY: 10000,
        VISIBLE_PRIORITY_DELAY: 200,
        CACHE_TTL: 7 * 24 * 60 * 60 * 1000,
        REQUEST_TIMEOUT: 5000
    };

    const visibilityObserver = new IntersectionObserver(handleIntersection, {
        rootMargin: '300px',
        threshold: 0.01
    });

    let currentUrl = window.location.href;
    let navigationHandlerSetup = false;

    function getUserId() {
        try {
            return (window.ApiClient?._serverInfo?.UserId) || null;
        } catch {
            return null;
        }
    }

    function saveCache() {
        try {
            const now = Date.now();
            for (const [key, entry] of Object.entries(ageRatingOverlayCache)) {
                if (now - entry.timestamp > config.CACHE_TTL) {
                    delete ageRatingOverlayCache[key];
                }
            }
            localStorage.setItem(CACHE_KEY, JSON.stringify(ageRatingOverlayCache));
        } catch (e) {
            console.warn('Failed to save cache', e);
        }
    }

function createIcon(rating) {
    let iconName = '';
    const ratingMap = {
        // MPAA Movie Ratings
        'G': 'GB-U',
        'PG': 'GB-PG',
        'PG-13': 'GB-12',
        'R': 'GB-15',
        'NC-17': 'GB-18',
        'U': 'GB-U',
        'PG': 'GB-PG',
        '12': 'GB-12',
        '15': 'GB-15',
        '18': 'GB-18',
        '12A': 'GB-12A',
        // US TV Ratings
        'TV-Y': 'GB-U',
        'TV-Y7': 'GB-PG',
        'TV-G': 'GB-U',
        'TV-PG': 'GB-PG',
        'TV-14': 'GB-12',
        'TV-MA': 'GB-15',
        'NR': 'GB-NR'
    };

    let mappedRating = rating;
    if (rating && !rating.startsWith('GB-')) {
        // Handle ratings with country prefix (e.g., US-TV-MA or US-PG)
        if (rating.startsWith('US-')) {
            mappedRating = ratingMap[rating.substring(3)];
        } else {
            // Handle ratings without prefix (e.g., TV-MA, PG)
            mappedRating = ratingMap[rating];
        }
    }

    // Default to 'nr.png' if no rating or invalid rating
    if (!mappedRating) {
        iconName = 'nr.png';
    } else if (mappedRating.startsWith('GB-')) {
        iconName = mappedRating.substring(3).toLowerCase() + '.png';
    } else {
        iconName = 'nr.png';
    }

    const img = document.createElement('img');
    img.src = `/web/agerating/${iconName}`;
    img.className = overlayClass;
    img.style.position = 'absolute';
    img.style.bottom = '3px';
    img.style.left = '3px';
    img.style.width = iconSize.width;
    img.style.height = iconSize.height;
    img.style.zIndex = '110';
    img.style.pointerEvents = 'none';
    img.style.userSelect = 'none';
    return img;
}
    async function fetchFirstEpisode(userId, seriesId) {
        try {
            const episodeResponse = await ApiClient.ajax({
                type: "GET",
                url: ApiClient.getUrl("/Items", {
                    ParentId: seriesId,
                    IncludeItemTypes: "Episode",
                    Recursive: true,
                    SortBy: "PremiereDate",
                    SortOrder: "Ascending",
                    Limit: 1,
                    userId: userId
                }),
                dataType: "json"
            });

            const episode = episodeResponse.Items?.[0];
            if (!episode?.Id) return null;
            return episode;
        } catch {
            return null;
        }
    }

    async function fetchItemRating(userId, itemId) {
        if (pendingRequests.has(itemId)) return null;
        pendingRequests.add(itemId);

        try {
            let item;
            try {
                item = await ApiClient.getItem(userId, itemId);
            } catch {
                const url = ApiClient.getUrl(`/Items/${itemId}`, { userId });
                const response = await fetchWithTimeout(url);
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                item = await response.json();
            }

            if (!item || !MEDIA_TYPES.has(item.Type)) return null;

            let rating = item.OfficialRating;

            if (!rating) {
                let targetItem;
                if (item.Type === 'Episode' || item.Type === 'Season') {
                    if (item.SeriesId) {
                        targetItem = await ApiClient.getItem(userId, item.SeriesId);
                        rating = targetItem?.OfficialRating;
                    }
                } else if (item.Type === 'Series') {
                    const ep = await fetchFirstEpisode(userId, item.Id);
                    if (ep?.Id) {
                        const fullEp = await ApiClient.getItem(userId, ep.Id);
                        rating = fullEp?.OfficialRating || item.OfficialRating;
                    }
                }
            }

            if (rating) {
                ageRatingOverlayCache[itemId] = {
                    rating,
                    timestamp: Date.now()
                };
                saveCache();
                return rating;
            }

            return null;
        } catch {
            handleApiError();
            return null;
        } finally {
            pendingRequests.delete(itemId);
        }
    }

    function handleApiError() {
        errorCount++;
        currentDelay = Math.min(
            config.MAX_DELAY,
            config.BASE_DELAY * Math.pow(2, Math.min(errorCount, 5)) * (0.8 + Math.random() * 0.4)
        );
    }

    function insertOverlay(container, rating) {
        if (!container || container.querySelector(`.${overlayClass}`)) return;

        const icon = createIcon(rating);
        if (!icon) return;

        if (getComputedStyle(container).position === 'static') {
            container.style.position = 'relative';
        }

        container.appendChild(icon);
    }

    function getItemIdFromElement(el) {
        if (el.href) {
            const match = el.href.match(/id=([a-f0-9]{32})/i);
            if (match) return match[1];
        }
        if (el.style.backgroundImage) {
            const match = el.style.backgroundImage.match(/\/Items\/([a-f0-9]{32})\//i);
            if (match) return match[1];
        }
        return null;
    }

    function shouldIgnoreElement(el) {
        return IGNORE_SELECTORS.some(selector => el.closest(selector) !== null);
    }

    async function processElement(el, isPriority = false) {
        if (shouldIgnoreElement(el)) return;

        const itemId = getItemIdFromElement(el);
        if (!itemId || seenItems.has(itemId)) return;
        seenItems.add(itemId);

        const cached = ageRatingOverlayCache[itemId];
        if (cached) {
            insertOverlay(el, cached.rating);
            return;
        }

        const userId = getUserId();
        if (!userId) return;

        const delay = isPriority ? 
            Math.min(config.VISIBLE_PRIORITY_DELAY, currentDelay) :
            currentDelay;

        await new Promise(resolve => setTimeout(resolve, delay));

        if (ageRatingOverlayCache[itemId]) {
            insertOverlay(el, ageRatingOverlayCache[itemId].rating);
            return;
        }

        const rating = await fetchItemRating(userId, itemId);
        if (rating) insertOverlay(el, rating);
    }

    function isElementVisible(el) {
        const rect = el.getBoundingClientRect();
        return (
            rect.top <= (window.innerHeight + 300) &&
            rect.bottom >= -300 &&
            rect.left <= (window.innerWidth + 300) &&
            rect.right >= -300
        );
    }

    function handleIntersection(entries) {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                const el = entry.target;
                visibilityObserver.unobserve(el);
                processElement(el, true);
            }
        });
    }

    function renderVisibleIcons() {
        const elements = Array.from(document.querySelectorAll('a.cardImageContainer, div.listItemImage'));
        
        elements.forEach(el => {
            if (shouldIgnoreElement(el)) return;

            const itemId = getItemIdFromElement(el);
            if (!itemId) return;

            const cached = ageRatingOverlayCache[itemId];
            if (cached) {
                insertOverlay(el, cached.rating);
                return;
            }

            if (isElementVisible(el)) {
                processElement(el, true);
            } else {
                visibilityObserver.observe(el);
            }
        });
    }

    function hookIntoHistoryChanges(callback) {
        const originalPushState = history.pushState;
        const originalReplaceState = history.replaceState;

        history.pushState = function (...args) {
            originalPushState.apply(this, args);
            callback();
        };

        history.replaceState = function (...args) {
            originalReplaceState.apply(this, args);
            callback();
        };

        window.addEventListener('popstate', callback);
    }

    function setupNavigationHandlers() {
        if (navigationHandlerSetup) return;
        navigationHandlerSetup = true;

        document.addEventListener('click', (e) => {
            const backButton = e.target.closest('button.headerButtonLeft:nth-child(1) > span:nth-child(1)');
            if (backButton) {
                setTimeout(() => {
                    seenItems.clear();
                    renderVisibleIcons();
                }, 500);
            }
        });

        hookIntoHistoryChanges(() => {
            currentUrl = window.location.href;
            seenItems.clear();
            visibilityObserver.disconnect();
            setTimeout(renderVisibleIcons, 300);
        });
    }

    function addStyles() {
        if (document.getElementById('age-rating-style')) return;
        const style = document.createElement('style');
        style.id = 'age-rating-style';
        style.textContent = `
            .${overlayClass} {
                user-select: none;
                pointer-events: none;
            }
        `;
        document.head.appendChild(style);
    }

    addStyles();
    
    setTimeout(() => {
        setupNavigationHandlers();
        renderVisibleIcons();
    }, 1500);

    window.addEventListener('beforeunload', saveCache);
    setInterval(saveCache, 60000);

    const mutationObserver = new MutationObserver((mutations) => {
        if (mutations.some(m => m.addedNodes.length > 0)) {
            setTimeout(renderVisibleIcons, 1000);
        }
    });
    mutationObserver.observe(document.body, { childList: true, subtree: true });

    async function fetchWithTimeout(url, timeout = config.REQUEST_TIMEOUT) {
        return Promise.race([
            fetch(url),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), timeout))
        ]);
    }
})();
