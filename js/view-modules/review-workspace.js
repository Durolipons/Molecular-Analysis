(function registerReviewWorkspaceModule(global) {
    let listenersBound = false;

    async function initializeWorkspace(deps) {
        deps.loadSelectedItems();
        deps.loadEnvironmentProfile();
        deps.loadWorkflowProject();
        await deps.initializeWorkflowBackend();
        deps.syncWorkflowProjectWithSelection();
        deps.displaySummary();
        deps.renderWorkflowProjectFields();
        deps.renderWorkflowProject();
        deps.renderEnvironmentForm();
        deps.renderEnvironmentSummary();
        deps.displayReferencePanels();
        deps.setupWorkflowControls();
        deps.setupEnvironmentProfileControls();
        deps.setupResumeLatestWorkflowControl();
        deps.setupSyncListeners();
    }

    function bindSyncListeners({ refreshReviewPage, displayReferencePanels }) {
        if (listenersBound) {
            return;
        }

        global.addEventListener('storage', event => {
            if (event.key === 'selectedMolecules') {
                console.log('Selection updated from Search window');
                refreshReviewPage();
            }
        });

        global.addEventListener('message', event => {
            if (event.data && event.data.type === 'selectionChanged') {
                console.log('Received selection change notification');
                refreshReviewPage();
            }
        });

        document.addEventListener('app-view-changed', event => {
            if (event.detail?.view === 'review') {
                displayReferencePanels();
            }
        });

        listenersBound = true;
    }

    function refreshWorkspace(deps) {
        deps.loadSelectedItems();
        deps.syncWorkflowProjectWithSelection();
        deps.displaySummary();
        deps.renderWorkflowProjectFields();
        deps.renderWorkflowProject();
        deps.renderEnvironmentSummary();
        deps.displayReferencePanels();

        if (deps.workflowProject.projectId) {
            void deps.refreshWorkflowProjectFromBackend(true);
        }
    }

    function openSearchView() {
        if (typeof global.switchAppView === 'function') {
            global.switchAppView('search');
            return;
        }

        global.location.href = 'index.html';
    }

    global.ReviewWorkspaceModule = Object.freeze({
        initializeWorkspace,
        bindSyncListeners,
        refreshWorkspace,
        openSearchView
    });
})(window);