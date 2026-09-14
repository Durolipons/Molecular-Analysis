(function registerSearchWorkspaceModule(global) {
    const SEARCH_STATE_STORAGE_KEY = 'searchState';
    const SELECTED_MOLECULES_STORAGE_KEY = 'selectedMolecules';

    function notifySelectionChanged(selected) {
        try {
            global.postMessage({
                type: 'selectionChanged',
                selectedCount: Array.isArray(selected) ? selected.length : 0
            }, global.location.origin);
        } catch (error) {
            console.warn('Unable to broadcast selection update:', error);
        }
    }

    function persistSearchState({ query, results, selectedIds }) {
        const normalizedResults = Array.isArray(results) ? results : [];
        const normalizedSelectedIds = Array.isArray(selectedIds) ? selectedIds : [];
        const searchState = {
            query: String(query || ''),
            results: normalizedResults,
            selected: normalizedSelectedIds
        };

        global.localStorage.setItem(SEARCH_STATE_STORAGE_KEY, JSON.stringify(searchState));

        const selected = normalizedResults.filter(result => normalizedSelectedIds.includes(result.id));
        global.localStorage.setItem(SELECTED_MOLECULES_STORAGE_KEY, JSON.stringify(selected));
        notifySelectionChanged(selected);
        return selected;
    }

    function readSearchState() {
        const stored = global.localStorage.getItem(SEARCH_STATE_STORAGE_KEY);
        if (!stored) {
            return null;
        }

        try {
            return JSON.parse(stored);
        } catch (error) {
            console.error('Error loading search state:', error);
            return null;
        }
    }

    function openReviewView(saveSearchState) {
        if (typeof saveSearchState === 'function') {
            saveSearchState();
        }

        if (typeof global.switchAppView === 'function') {
            global.switchAppView('review');
            return;
        }

        global.location.href = 'review.html';
    }

    global.SearchWorkspaceModule = Object.freeze({
        notifySelectionChanged,
        persistSearchState,
        readSearchState,
        openReviewView
    });
})(window);