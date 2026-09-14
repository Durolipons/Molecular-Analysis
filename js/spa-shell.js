const APP_VIEW_METADATA = Object.freeze({
    search: {
        title: 'Molecular Analysis Workspace',
        subtitle: 'Search across molecular databases, curate selections, and move directly into workflow review.'
    },
    review: {
        title: 'Molecular Analysis Workspace',
        subtitle: 'Inspect selected molecules, recover saved projects, and run the local MD workflow from one shell.'
    }
});

let activeAppView = 'search';

function normalizeAppView(value) {
    return String(value || '').trim().toLowerCase() === 'review' ? 'review' : 'search';
}

function getRequestedAppView() {
    return normalizeAppView(window.location.hash.replace(/^#/, ''));
}

function updateShellHeader(view) {
    const metadata = APP_VIEW_METADATA[view] || APP_VIEW_METADATA.search;
    const titleElement = document.getElementById('app-shell-title');
    const subtitleElement = document.getElementById('app-shell-subtitle');

    if (titleElement) {
        titleElement.textContent = metadata.title;
    }

    if (subtitleElement) {
        subtitleElement.textContent = metadata.subtitle;
    }
}

function updateShellNavigation(view) {
    document.querySelectorAll('[data-app-view]').forEach(button => {
        const isActive = button.dataset.appView === view;
        button.classList.toggle('active', isActive);
        button.setAttribute('aria-current', isActive ? 'page' : 'false');
    });
}

function setActiveAppView(view, options = {}) {
    const normalizedView = normalizeAppView(view);
    const searchView = document.getElementById('search-view');
    const reviewView = document.getElementById('review-view');

    if (!searchView || !reviewView) {
        activeAppView = normalizedView;
        return normalizedView;
    }

    activeAppView = normalizedView;
    searchView.classList.toggle('hidden', normalizedView !== 'search');
    reviewView.classList.toggle('hidden', normalizedView !== 'review');
    updateShellHeader(normalizedView);
    updateShellNavigation(normalizedView);

    if (options.updateHash !== false) {
        const nextHash = `#${normalizedView}`;
        if (window.location.hash !== nextHash) {
            history.replaceState(null, '', nextHash);
        }
    }

    document.dispatchEvent(new CustomEvent('app-view-changed', {
        detail: { view: normalizedView }
    }));

    return normalizedView;
}

window.switchAppView = function switchAppView(view, options = {}) {
    return setActiveAppView(view, options);
};

window.getActiveAppView = function getActiveAppView() {
    return activeAppView;
};

class SearchWorkspace extends HTMLElement {
    connectedCallback() {
        if (this.dataset.rendered === 'true') {
            return;
        }

        this.dataset.rendered = 'true';
        this.innerHTML = `
            <section class="workspace-banner">
                <div class="workspace-banner-copy">
                    <strong>Search Workspace</strong>
                    <p>Search multiple molecular sources from one local shell. Results and selections persist directly into the review and workflow view.</p>
                </div>
                <span class="workspace-banner-badge">Single-page desktop flow</span>
            </section>

            <div class="search-section">
                <div class="search-form">
                    <div class="form-group">
                        <label for="search-input">Search All Databases:</label>
                        <input
                            type="text"
                            id="search-input"
                            class="search-input"
                            placeholder="Enter protein name, compound, or ID (e.g., P12345, aspirin, 1CRN)..."
                            autocomplete="off"
                        >
                        <small id="search-hint" class="search-hint">Examples: P12345, aspirin, 1CRN, insulin, CHEMBL25</small>
                    </div>

                    <button id="search-btn" class="search-btn" type="button">
                        <span class="btn-text">Search All Databases</span>
                        <span class="btn-icon">🔍</span>
                    </button>

                    <div class="action-buttons hidden" id="action-buttons">
                        <button id="select-all-btn" class="action-btn" type="button">Select All</button>
                        <button id="deselect-all-btn" class="action-btn" type="button">Deselect All</button>
                        <button id="use-selected-btn" class="primary-action-btn" type="button">Use Selected Items (0)</button>
                    </div>
                </div>
            </div>

            <div id="results-section" class="results-section hidden">
                <div class="results-header">
                    <h2>Search Results</h2>
                    <div id="search-stats" class="search-stats"></div>
                </div>

                <div class="filter-section" id="filter-section">
                    <div class="filter-row">
                        <div class="filter-group">
                            <label>Filter by Database:</label>
                            <div class="filter-buttons" id="db-filters">
                                <button class="filter-btn active" data-filter="all" type="button">All</button>
                                <button class="filter-btn" data-filter="alphafold" type="button">🔮 AlphaFold</button>
                                <button class="filter-btn" data-filter="pdb" type="button">🧬 PDB</button>
                                <button class="filter-btn" data-filter="uniprot" type="button">🔬 UniProt</button>
                                <button class="filter-btn" data-filter="pubchem" type="button">⚗️ PubChem</button>
                                <button class="filter-btn" data-filter="chembl" type="button">💊 ChEMBL</button>
                                <button class="filter-btn" data-filter="kegg" type="button">🧪 KEGG</button>
                            </div>
                        </div>
                    </div>
                    <div class="filter-row">
                        <div class="filter-group">
                            <label>Sort by:</label>
                            <select id="sort-select" class="filter-select">
                                <option value="relevance">Relevance</option>
                                <option value="name-asc">Name (A-Z)</option>
                                <option value="name-desc">Name (Z-A)</option>
                                <option value="database">Database</option>
                            </select>
                        </div>
                        <div class="filter-group">
                            <label>Type:</label>
                            <select id="type-select" class="filter-select">
                                <option value="all">All Types</option>
                                <option value="protein">Proteins</option>
                                <option value="structure">3D Structures</option>
                                <option value="compound">Compounds</option>
                                <option value="pathway">Pathways</option>
                            </select>
                        </div>
                        <div class="filter-group search-filter">
                            <label>Filter results:</label>
                            <input type="text" id="result-filter" class="filter-input" placeholder="Type to filter...">
                        </div>
                    </div>
                </div>

                <div id="loading" class="loading hidden">
                    <div class="spinner"></div>
                    <p>Searching all databases...</p>
                </div>
                <div id="results-container" class="results-container"></div>
            </div>
        `;
    }
}

class ReviewWorkspace extends HTMLElement {
    connectedCallback() {
        if (this.dataset.rendered === 'true') {
            return;
        }

        this.dataset.rendered = 'true';
        this.innerHTML = `
            <section class="workspace-banner">
                <div class="workspace-banner-copy">
                    <strong>Review And Workflow Workspace</strong>
                    <p>Selections from Search flow directly into the saved-project recovery, environment profile, and guided simulation workflow without leaving the shell.</p>
                </div>
                <span class="workspace-banner-badge">Same backend contract</span>
            </section>

            <div id="summary-section" class="summary-section">
                <h2>Selected Items Summary</h2>
                <div id="summary-stats" class="summary-stats">
                    <div class="stat-card">
                        <span class="stat-number" id="total-items">0</span>
                        <span class="stat-label">Total Items</span>
                    </div>
                    <div class="stat-card">
                        <span class="stat-number" id="pdb-count">0</span>
                        <span class="stat-label">PDB Structures</span>
                    </div>
                    <div class="stat-card">
                        <span class="stat-number" id="protein-count">0</span>
                        <span class="stat-label">Proteins</span>
                    </div>
                    <div class="stat-card">
                        <span class="stat-number" id="compound-count">0</span>
                        <span class="stat-label">Compounds</span>
                    </div>
                </div>
            </div>

            <section id="workflow-section" class="workflow-section">
                <div class="workflow-header">
                    <div>
                        <h2>Guided Simulation Workflow</h2>
                        <p class="workflow-subtitle">Windows-first orchestration for protein and protein-ligand molecular dynamics without manual file chasing.</p>
                    </div>
                    <button id="workflow-reset-btn" class="action-btn" type="button">Reset Workflow</button>
                </div>

                <div class="workflow-project-bar">
                    <label class="workflow-field">
                        <span>Project Name</span>
                        <input type="text" id="workflow-project-name" placeholder="Protein-ligand MD project">
                    </label>

                    <label class="workflow-field">
                        <span>Workflow Type</span>
                        <select id="workflow-type-select">
                            <option value="protein-water">Protein in Water</option>
                            <option value="protein-ligand-water">Protein-Ligand in Water</option>
                            <option value="reactive-md-test">Reactive MD Test (H+H₂ Exchange)</option>
                        </select>
                    </label>

                    <label class="workflow-field">
                        <span>Simulation Engine</span>
                        <select id="workflow-engine-select">
                            <option value="openmm">OpenMM Windows Native</option>
                            <option value="hybrid">Windows Native + Compatibility Export</option>
                            <option value="gromacs-export">GROMACS Compatibility Export</option>
                        </select>
                    </label>

                    <label class="workflow-field">
                        <span>Presets</span>
                        <div class="workflow-project-picker">
                            <select id="workflow-preset-select">
                                <option value="">— select a preset —</option>
                                <option value="reactive-md-h3">Reactive MD: H + H₂ Exchange</option>
                            </select>
                            <button type="button" id="workflow-preset-apply-btn" class="workflow-picker-btn">Apply</button>
                        </div>
                        <small class="workflow-picker-caption">Fills stage parameters from a validated starting point. Does not overwrite a saved project.</small>
                    </label>

                    <label class="workflow-field">
                        <span>Saved Projects</span>
                        <div class="workflow-project-picker">
                            <select id="workflow-saved-project-select">
                                <option value="">No saved workflow projects on disk</option>
                            </select>
                            <button type="button" id="workflow-project-refresh-btn" class="workflow-picker-btn">Refresh</button>
                        </div>
                        <small id="workflow-project-picker-caption" class="workflow-picker-caption">No saved workflow projects have been discovered yet.</small>
                    </label>
                </div>

                <div id="workflow-project-summary" class="workflow-project-summary"></div>

                <div class="workflow-layout">
                    <div id="workflow-stage-list" class="workflow-stage-list"></div>
                    <div id="workflow-stage-detail" class="workflow-stage-detail"></div>
                </div>
            </section>

            <section id="environment-section" class="environment-section">
                <div class="environment-header">
                    <div>
                        <h2>Environment Profile</h2>
                        <p class="environment-subtitle">Capture assay and biological context before interpreting molecular results.</p>
                    </div>
                    <button id="environment-reset-btn" class="action-btn" type="button">Reset Profile</button>
                </div>

                <form id="environment-form" class="environment-form">
                    <label class="environment-field">
                        <span>Profile Name</span>
                        <input type="text" id="env-profile-name" name="profileName" placeholder="Physiological buffer, acidic endosome, membrane assay...">
                    </label>

                    <label class="environment-field">
                        <span>pH</span>
                        <input type="number" id="env-ph" name="ph" min="0" max="14" step="0.1" value="7.4">
                    </label>

                    <label class="environment-field">
                        <span>Temperature (C)</span>
                        <input type="number" id="env-temperature" name="temperatureC" min="-20" max="200" step="0.5" value="25">
                    </label>

                    <label class="environment-field">
                        <span>Ionic Strength (mM)</span>
                        <input type="number" id="env-ionic-strength" name="ionicStrengthmM" min="0" max="5000" step="1" value="150">
                    </label>

                    <label class="environment-field">
                        <span>Dominant Solvent</span>
                        <select id="env-solvent" name="solvent">
                            <option value="aqueous">Aqueous Buffer</option>
                            <option value="mixed">Mixed Solvent</option>
                            <option value="organic">Organic-Rich</option>
                            <option value="membrane">Membrane-Associated</option>
                        </select>
                    </label>

                    <label class="environment-field">
                        <span>Metal / Cofactor Context</span>
                        <input type="text" id="env-cofactors" name="cofactors" placeholder="Zn2+, Mg2+, heme, ATP...">
                    </label>

                    <label class="environment-field environment-field-wide">
                        <span>Experimental Context</span>
                        <textarea id="env-notes" name="notes" rows="3" placeholder="Assay buffer, membrane system, mutations, crowding, redox state, or other assumptions."></textarea>
                    </label>
                </form>

                <div id="environment-summary" class="environment-summary"></div>
            </section>

            <div id="panels-container" class="panels-container"></div>

            <div id="no-selection" class="no-selection hidden">
                <div class="empty-state">
                    <h2>No Items Selected</h2>
                    <p>You haven't selected any items yet. Search for molecules, select the records you want, and then return here to review them.</p>
                    <button type="button" id="resume-latest-workflow-btn" class="primary-action-btn">Resume Latest Workflow</button>
                    <div id="resume-workflow-project-list" class="empty-state-project-list"></div>
                    <div class="empty-state-divider">— or start a new workflow —</div>
                    <div class="empty-state-preset-row">
                        <select id="empty-state-preset-select">
                            <option value="">— apply a preset —</option>
                            <option value="reactive-md-h3">Reactive MD: H + H₂ Exchange</option>
                        </select>
                        <button type="button" id="empty-state-preset-apply-btn" class="primary-action-btn">Apply &amp; Start</button>
                    </div>
                    <button type="button" class="primary-action-btn" onclick="openSearchWindow()">Go to Search</button>
                </div>
            </div>
        `;
    }
}

class MolecularApp extends HTMLElement {
    connectedCallback() {
        if (this.dataset.rendered === 'true') {
            return;
        }

        this.dataset.rendered = 'true';
        this.innerHTML = `
            <div class="container">
                <header>
                    <h1 id="app-shell-title">${APP_VIEW_METADATA.search.title}</h1>
                    <p id="app-shell-subtitle" class="subtitle">${APP_VIEW_METADATA.search.subtitle}</p>
                    <nav class="header-nav" aria-label="Workspace views">
                        <button class="nav-btn active" data-app-view="search" type="button">🔍 Search</button>
                        <button class="nav-btn" data-app-view="review" type="button">📋 Review</button>
                    </nav>
                </header>

                <main class="app-shell-main">
                    <section id="search-view" class="spa-view">
                        <search-workspace></search-workspace>
                    </section>
                    <section id="review-view" class="spa-view hidden">
                        <review-workspace></review-workspace>
                    </section>
                </main>

                <footer>
                    <p>Molecular Analysis Tool v1.0 | Unified search, review, workflow, and desktop preview shell</p>
                </footer>
            </div>
        `;

        this.querySelectorAll('[data-app-view]').forEach(button => {
            button.addEventListener('click', () => {
                setActiveAppView(button.dataset.appView);
            });
        });

        setActiveAppView(getRequestedAppView(), { updateHash: true });
    }
}

window.addEventListener('hashchange', () => {
    setActiveAppView(getRequestedAppView(), { updateHash: false });
});

customElements.define('search-workspace', SearchWorkspace);
customElements.define('review-workspace', ReviewWorkspace);
customElements.define('molecular-app', MolecularApp);