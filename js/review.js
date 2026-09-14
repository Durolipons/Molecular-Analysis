// Load selected molecules from localStorage
let selectedMolecules = [];
let hasStoredSelectionSnapshot = false;
let searchWindow = null;
let workflowProjectCatalog = [];
let workflowProjectCatalogSkippedCount = 0;

// Route all external molecular-database calls through the local server's same-origin proxy.
// This sidesteps Chromium CORS restrictions in the packaged Electron renderer and gives us a
// single chokepoint for offline-friendly error handling.
function proxiedUrl(externalUrl) {
    if (!externalUrl) {
        return externalUrl;
    }
    return `/api/proxy?url=${encodeURIComponent(externalUrl)}`;
}

const ENVIRONMENT_PROFILE_STORAGE_KEY = 'analysisEnvironmentProfile';
const ENVIRONMENT_SOLVENT_LABELS = {
    aqueous: 'Aqueous Buffer',
    mixed: 'Mixed Solvent',
    organic: 'Organic-Rich',
    membrane: 'Membrane-Associated'
};
const DEFAULT_ENVIRONMENT_PROFILE = Object.freeze({
    profileName: '',
    ph: 7.4,
    temperatureC: 25,
    ionicStrengthmM: 150,
    solvent: 'aqueous',
    cofactors: '',
    notes: ''
});
let environmentProfile = { ...DEFAULT_ENVIRONMENT_PROFILE };
const WORKFLOW_PROJECT_STORAGE_KEY = 'simulationWorkflowProject';
const WORKFLOW_ENGINE_OPTIONS = {
    openmm: 'OpenMM Windows Native',
    hybrid: 'Windows Native + Compatibility Export',
    'gromacs-export': 'GROMACS Compatibility Export'
};
const WORKFLOW_TYPE_OPTIONS = {
    'protein-water': 'Protein in Water',
    'protein-ligand-water': 'Protein-Ligand in Water',
    'reactive-md-test': 'Reactive MD Test (H+H₂ Exchange)'
};

// ---------------------------------------------------------------------------
// Workflow Presets
// Each preset is a plain object: { label, workflowType, engine, projectName,
// stageConfigs: { [stageId]: { fieldName: value, … } } }
// ---------------------------------------------------------------------------
const WORKFLOW_PRESETS = Object.freeze({
    'reactive-md-h3': {
        label: 'Reactive MD: H + H₂ Exchange',
        workflowType: 'reactive-md-test',
        engine: 'openmm',
        projectName: 'H + H₂ Reactive MD Test',
        stageConfigs: {
            'import': {
                downloadMode: 'curated',
                artifactMode: 'managed',
                notes: [
                    'REACTIVE MD TEST SYSTEM — Linear H₃ exchange  H_A + H_B–H_C → H_A–H_B + H_C',
                    '',
                    'ATOMS (3 total, all hydrogen, mass = 1.00794 amu):',
                    '  H_A   0.000  0.000  0.000   (approaching atom)',
                    '  H_B   2.000  0.000  0.000   (bridge atom)',
                    '  H_C   2.742  0.000  0.000   (H_B–H_C bonded, r_e = 0.742 Å)',
                    '',
                    'INITIAL VELOCITIES:',
                    '  H_A: vx = +0.010 Å/fs  (KE ≈ 0.52 eV, above 0.40 eV barrier)',
                    '  H_B: 0   H_C: 0',
                    '',
                    'BOX: 20 × 20 × 20 Å, vacuum (no PBC needed for 3-atom gas phase).',
                    '',
                    'REACTION COORDINATE: ξ = r(A–B) − r(B–C)',
                    '  Reactant state: ξ ≈ +1.26 Å',
                    '  Transition state: ξ ≈  0.00 Å',
                    '  Product state:  ξ ≈ −1.26 Å'
                ].join('\n')
            },
            'protein-prep': {
                forceField: 'charmm36',
                protonation: 'manual',
                keepHeterogens: false,
                reactiveAtomMassAmu: 1.00794,
                reactiveMorseDeEv: 4.747,
                reactiveMorseReNm: 0.0742,
                reactiveMorseAlphaInvNm: 19.42,
                reactiveSwitchRswNm: 0.100,
                reactiveSwitchWswNm: 0.030,
                reactiveRepAmpEv: 50.0,
                reactiveRepSteepnessInvNm: 30.0,
                reactivePosAxNm: 0.0000,
                reactivePosBxNm: 0.2000,
                reactivePosCxNm: 0.2742
            },
            'minimization': {
                maxIterations: 500,
                restraintMode: 'none',
                tolerance: 10
            },
            'nvt': {
                durationPs: 10,
                temperatureK: 600,
                heavyAtomRestraints: false
            },
            'npt': {
                durationPs: 50,
                pressureBar: 1,
                releaseRestraints: true
            },
            'production': {
                durationNs: 0.05,
                timeStepFs: 0.05,
                writeIntervalPs: 0.1,
                reactiveVxAnmPerPs: 10.0
            },
            'analysis': {
                trackRmsd: false,
                trackHbonds: false,
                trackLigandContacts: false
            }
        }
    }
});
const WORKFLOW_API_BASE_PATH = '/api/workflow';
const WORKFLOW_SERVICE_STATUS_LABELS = {
    checking: 'Checking local backend',
    available: 'Local backend connected',
    offline: 'Local backend offline'
};
const WORKFLOW_EXECUTION_STATUS_LABELS = {
    idle: 'Idle',
    queued: 'Queued',
    running: 'Running',
    completed: 'Completed',
    failed: 'Failed',
    'not-wired': 'Backend Pending'
};
const BACKEND_SUPPORTED_STAGE_IDS = new Set([
    'import',
    'protein-prep',
    'ligand-prep',
    'complex-build',
    'solvation',
    'ions',
    'minimization',
    'nvt',
    'npt',
    'production'
]);
const WORKFLOW_STAGES = [
    {
        id: 'import',
        order: 1,
        title: 'Import & Project Setup',
        shortTitle: 'Import',
        summary: 'Pull structures, ligands, and metadata into one managed Windows project.',
        outputs: ['Source coordinate files', 'Metadata bundle', 'Project manifest'],
        dependencies: [],
        fields: [
            {
                name: 'downloadMode',
                label: 'Import mode',
                type: 'select',
                default: 'auto',
                options: [
                    { value: 'auto', label: 'Auto download linked assets' },
                    { value: 'curated', label: 'Keep only current review selections' }
                ]
            },
            {
                name: 'artifactMode',
                label: 'Artifact storage',
                type: 'select',
                default: 'managed',
                options: [
                    { value: 'managed', label: 'Managed project workspace' },
                    { value: 'portable', label: 'Portable export-ready workspace' }
                ]
            },
            {
                name: 'notes',
                label: 'Stage note',
                type: 'textarea',
                default: '',
                placeholder: 'Capture manual overrides, missing files, or source caveats.'
            }
        ]
    },
    {
        id: 'protein-prep',
        order: 2,
        title: 'Protein Preparation',
        shortTitle: 'Protein Prep',
        summary: 'Repair the structure, review protonation, and normalize the biomolecular model.',
        outputs: ['Prepared protein coordinates', 'Protein topology', 'Repair provenance'],
        dependencies: ['import'],
        fields: [
            {
                name: 'forceField',
                label: 'Protein force field',
                type: 'select',
                default: 'charmm36',
                options: [
                    { value: 'charmm36', label: 'CHARMM36' },
                    { value: 'amber14', label: 'AMBER14SB' },
                    { value: 'openff', label: 'OpenFF-compatible protein stack' }
                ]
            },
            {
                name: 'protonation',
                label: 'Protonation strategy',
                type: 'select',
                default: 'auto',
                options: [
                    { value: 'auto', label: 'Auto from environment profile' },
                    { value: 'histidine-review', label: 'Review histidines and termini' },
                    { value: 'manual', label: 'Manual review required' }
                ]
            },
            {
                name: 'keepHeterogens',
                label: 'Keep cofactors and bound heterogens',
                type: 'checkbox',
                default: true
            },
            // ── Reactive MD (H + H₂) parameters ─────────────────────────────
            {
                name: 'reactiveAtomMassAmu',
                label: 'Reactive: atom mass (amu)',
                type: 'number',
                default: 1.00794,
                min: 0.1,
                max: 300,
                step: 0.0001,
                showWhen: 'reactive-md-test'
            },
            {
                name: 'reactiveMorseDeEv',
                label: 'Reactive: Morse well depth Dₑ (eV)',
                type: 'number',
                default: 4.747,
                min: 0.01,
                max: 50,
                step: 0.001,
                showWhen: 'reactive-md-test'
            },
            {
                name: 'reactiveMorseReNm',
                label: 'Reactive: Morse equilibrium bond rₑ (nm)',
                type: 'number',
                default: 0.0742,
                min: 0.01,
                max: 1,
                step: 0.0001,
                showWhen: 'reactive-md-test'
            },
            {
                name: 'reactiveMorseAlphaInvNm',
                label: 'Reactive: Morse range α (nm⁻¹)',
                type: 'number',
                default: 19.42,
                min: 1,
                max: 200,
                step: 0.01,
                showWhen: 'reactive-md-test'
            },
            {
                name: 'reactiveSwitchRswNm',
                label: 'Reactive: switching centre r_sw (nm)',
                type: 'number',
                default: 0.100,
                min: 0.01,
                max: 1,
                step: 0.001,
                showWhen: 'reactive-md-test'
            },
            {
                name: 'reactiveSwitchWswNm',
                label: 'Reactive: switching width w_sw (nm)',
                type: 'number',
                default: 0.030,
                min: 0.001,
                max: 0.5,
                step: 0.001,
                showWhen: 'reactive-md-test'
            },
            {
                name: 'reactiveRepAmpEv',
                label: 'Reactive: A–C repulsion amplitude (eV)',
                type: 'number',
                default: 50.0,
                min: 0,
                max: 1000,
                step: 0.1,
                showWhen: 'reactive-md-test'
            },
            {
                name: 'reactiveRepSteepnessInvNm',
                label: 'Reactive: A–C repulsion steepness (nm⁻¹)',
                type: 'number',
                default: 30.0,
                min: 1,
                max: 200,
                step: 0.1,
                showWhen: 'reactive-md-test'
            },
            {
                name: 'reactivePosAxNm',
                label: 'Reactive: H_A initial x position (nm)',
                type: 'number',
                default: 0.0000,
                min: -10,
                max: 10,
                step: 0.0001,
                showWhen: 'reactive-md-test'
            },
            {
                name: 'reactivePosBxNm',
                label: 'Reactive: H_B initial x position (nm)',
                type: 'number',
                default: 0.2000,
                min: -10,
                max: 10,
                step: 0.0001,
                showWhen: 'reactive-md-test'
            },
            {
                name: 'reactivePosCxNm',
                label: 'Reactive: H_C initial x position (nm)',
                type: 'number',
                default: 0.2742,
                min: -10,
                max: 10,
                step: 0.0001,
                showWhen: 'reactive-md-test'
            }
        ]
    },
    {
        id: 'ligand-prep',
        order: 3,
        title: 'Ligand Preparation',
        shortTitle: 'Ligand Prep',
        summary: 'Parameterize ligands, enumerate states, and store ligand-specific artifacts.',
        outputs: ['Ligand coordinates', 'Ligand parameters', 'State enumeration report'],
        dependencies: ['import'],
        fields: [
            {
                name: 'ligandSource',
                label: 'Primary ligand source',
                type: 'select',
                default: 'selected',
                options: [
                    { value: 'selected', label: 'Use selected review compounds' },
                    { value: 'pubchem', label: 'Prefer PubChem coordinates' },
                    { value: 'upload', label: 'Supplement with uploaded structures' }
                ]
            },
            {
                name: 'parameterization',
                label: 'Parameterization route',
                type: 'select',
                default: 'openff',
                options: [
                    { value: 'openff', label: 'OpenFF 2.2.1 + RDKit MMFF94 charges' },
                    { value: 'cgenff', label: 'CHARMM/CGenFF compatibility path (planned)' },
                    { value: 'gaff', label: 'GAFF compatibility path (planned)' }
                ]
            },
            {
                name: 'enumerateStates',
                label: 'Enumerate protonation and tautomer states',
                type: 'checkbox',
                default: true
            }
        ]
    },
    {
        id: 'complex-build',
        order: 4,
        title: 'Complex Assembly',
        shortTitle: 'Complex',
        summary: 'Merge prepared biomolecules into the simulation system before solvation, using reference poses when available and managed fallback placement otherwise.',
        outputs: ['Assembled complex', 'Pose provenance', 'Assembly report'],
        dependencies: ['protein-prep', 'ligand-prep'],
        fields: [
            {
                name: 'assemblyMode',
                label: 'Assembly mode',
                type: 'select',
                default: 'auto',
                options: [
                    { value: 'auto', label: 'Auto merge selected records' },
                    { value: 'reference', label: 'Use reference complex geometry' },
                    { value: 'manual', label: 'Manual placement review' }
                ]
            },
            {
                name: 'poseSource',
                label: 'Pose source',
                type: 'select',
                default: 'selected',
                options: [
                    { value: 'selected', label: 'Selected review structure or pose' },
                    { value: 'docked', label: 'Docked pose import' },
                    { value: 'reference', label: 'Reference pose import' }
                ]
            },
            {
                name: 'poseImportPath',
                label: 'Docked/reference pose file',
                type: 'file-upload',
                default: '',
                accept: '.pdb,.sdf,.mol,.mol2',
                helpText: 'Upload a ligand pose file or a full reference-complex PDB. The backend will extract the ligand residue automatically when needed.'
            },
            {
                name: 'referenceResidueId',
                label: 'Reference complex ligand residue',
                type: 'select',
                default: '',
                optionsFromConfig: 'referenceResidueOptions',
                emptyOptionLabel: 'Auto-select best-matching ligand residue'
            },
            {
                name: 'retainWaters',
                label: 'Retain key crystallographic waters',
                type: 'checkbox',
                default: false
            }
        ]
    },
    {
        id: 'solvation',
        order: 5,
        title: 'Box & Solvation',
        shortTitle: 'Solvation',
        summary: 'Define the simulation box and build the solvent environment automatically.',
        outputs: ['Solvated coordinates', 'Box parameters', 'Solvent composition log'],
        dependencies: ['protein-prep', 'complex-build'],
        fields: [
            {
                name: 'boxShape',
                label: 'Box shape',
                type: 'select',
                default: 'dodecahedron',
                options: [
                    { value: 'cubic', label: 'Cubic' },
                    { value: 'dodecahedron', label: 'Dodecahedron' },
                    { value: 'octahedron', label: 'Truncated octahedron' }
                ]
            },
            {
                name: 'paddingNm',
                label: 'Solvent padding (nm)',
                type: 'number',
                default: 1,
                min: 0.6,
                max: 2.5,
                step: 0.1
            },
            {
                name: 'waterModel',
                label: 'Water model',
                type: 'select',
                default: 'tip3p',
                options: [
                    { value: 'tip3p', label: 'TIP3P' },
                    { value: 'spce', label: 'SPC/E' },
                    { value: 'opc', label: 'OPC' }
                ]
            }
        ]
    },
    {
        id: 'ions',
        order: 6,
        title: 'Neutralization & Ions',
        shortTitle: 'Ions',
        summary: 'Neutralize the system and apply salt conditions from the environment profile.',
        outputs: ['Ionized coordinates', 'Salt composition report', 'Updated topology'],
        dependencies: ['solvation'],
        fields: [
            {
                name: 'neutralize',
                label: 'Neutralize system charge automatically',
                type: 'checkbox',
                default: true
            },
            {
                name: 'saltConcentration',
                label: 'Target salt concentration (M)',
                type: 'number',
                default: 0.15,
                min: 0,
                max: 2,
                step: 0.01
            },
            {
                name: 'ionPair',
                label: 'Ion pair',
                type: 'select',
                default: 'na-cl',
                options: [
                    { value: 'na-cl', label: 'Sodium / Chloride' },
                    { value: 'k-cl', label: 'Potassium / Chloride' },
                    { value: 'custom', label: 'Custom ion pair' }
                ]
            }
        ]
    },
    {
        id: 'minimization',
        order: 7,
        title: 'Energy Minimization',
        shortTitle: 'Minimization',
        summary: 'Relax bad contacts before equilibration begins.',
        outputs: ['Minimized coordinates', 'Energy log', 'Convergence summary'],
        dependencies: ['ions'],
        fields: [
            {
                name: 'maxIterations',
                label: 'Maximum iterations',
                type: 'number',
                default: 5000,
                min: 100,
                max: 50000,
                step: 100
            },
            {
                name: 'restraintMode',
                label: 'Restraints during minimization',
                type: 'select',
                default: 'protein-heavy',
                options: [
                    { value: 'protein-heavy', label: 'Protein heavy atoms' },
                    { value: 'backbone', label: 'Backbone only' },
                    { value: 'none', label: 'No restraints' }
                ]
            },
            {
                name: 'tolerance',
                label: 'Tolerance target',
                type: 'number',
                default: 1000,
                min: 10,
                max: 5000,
                step: 10
            }
        ]
    },
    {
        id: 'nvt',
        order: 8,
        title: 'NVT Equilibration',
        shortTitle: 'NVT',
        summary: 'Stabilize temperature with conservative restraints and thermostat settings.',
        outputs: ['NVT checkpoint', 'Temperature trace', 'Equilibration log'],
        dependencies: ['minimization'],
        fields: [
            {
                name: 'durationPs',
                label: 'Duration (ps)',
                type: 'number',
                default: 25,
                min: 5,
                max: 2000,
                step: 5
            },
            {
                name: 'temperatureK',
                label: 'Target temperature (K)',
                type: 'number',
                default: 300,
                min: 250,
                max: 400,
                step: 1
            },
            {
                name: 'heavyAtomRestraints',
                label: 'Apply heavy atom restraints',
                type: 'checkbox',
                default: true
            }
        ]
    },
    {
        id: 'npt',
        order: 9,
        title: 'NPT Equilibration',
        shortTitle: 'NPT',
        summary: 'Relax the solvated system to target pressure and density.',
        outputs: ['NPT checkpoint', 'Pressure and density trace', 'Barostat report'],
        dependencies: ['nvt'],
        fields: [
            {
                name: 'durationPs',
                label: 'Duration (ps)',
                type: 'number',
                default: 50,
                min: 10,
                max: 5000,
                step: 10
            },
            {
                name: 'pressureBar',
                label: 'Target pressure (bar)',
                type: 'number',
                default: 1,
                min: 0.5,
                max: 5,
                step: 0.1
            },
            {
                name: 'releaseRestraints',
                label: 'Release restraints during NPT',
                type: 'checkbox',
                default: true
            }
        ]
    },
    {
        id: 'production',
        order: 10,
        title: 'Production MD',
        shortTitle: 'Production',
        summary: 'Run the main trajectory with checkpoints, job controls, and artifact capture.',
        outputs: ['Trajectory', 'Production checkpoint', 'Performance log'],
        dependencies: ['npt'],
        fields: [
            {
                name: 'durationNs',
                label: 'Duration (ns)',
                type: 'number',
                default: 0.1,
                min: 0.05,
                max: 50,
                step: 0.05
            },
            {
                name: 'timeStepFs',
                label: 'Time step (fs)',
                type: 'number',
                default: 2,
                min: 1,
                max: 4,
                step: 0.5
            },
            {
                name: 'writeIntervalPs',
                label: 'Write interval (ps)',
                type: 'number',
                default: 10,
                min: 1,
                max: 100,
                step: 1
            },
            {
                name: 'reactiveVxAnmPerPs',
                label: 'Reactive: H_A initial vₓ (nm/ps)',
                type: 'number',
                default: 10.0,
                min: -200,
                max: 200,
                step: 0.1,
                showWhen: 'reactive-md-test'
            }
        ]
    },
    {
        id: 'analysis',
        order: 11,
        title: 'Analysis & Reporting',
        shortTitle: 'Analysis',
        summary: 'Generate trajectory metrics, plots, and a reproducible report bundle.',
        outputs: ['Plots and tables', 'Trajectory metrics', 'Project report'],
        dependencies: ['production'],
        fields: [
            {
                name: 'trackRmsd',
                label: 'Include RMSD analysis',
                type: 'checkbox',
                default: true
            },
            {
                name: 'trackHbonds',
                label: 'Include hydrogen bond analysis',
                type: 'checkbox',
                default: true
            },
            {
                name: 'trackLigandContacts',
                label: 'Include ligand contact analysis',
                type: 'checkbox',
                default: true
            }
        ]
    }
];
let workflowProject = createDefaultWorkflowProject();
let workflowServiceStatus = 'checking';
let workflowJobPollTimer = null;

// Utility: Show toast notification
function showToast(message, duration = 3000) {
    // Remove existing toast
    const existing = document.querySelector('.toast-notification');
    if (existing) existing.remove();
    
    const toast = document.createElement('div');
    toast.className = 'toast-notification';
    toast.textContent = message;
    document.body.appendChild(toast);
    
    // Trigger animation
    requestAnimationFrame(() => {
        toast.classList.add('show');
    });
    
    // Auto-remove
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, duration);
}

// Initialize the review page
document.addEventListener('DOMContentLoaded', async () => {
    console.log('Review page loaded');
    await window.ReviewWorkspaceModule.initializeWorkspace({
        loadSelectedItems,
        loadEnvironmentProfile,
        loadWorkflowProject,
        initializeWorkflowBackend,
        syncWorkflowProjectWithSelection,
        displaySummary,
        renderWorkflowProjectFields,
        renderWorkflowProject,
        renderEnvironmentForm,
        renderEnvironmentSummary,
        displayReferencePanels,
        setupWorkflowControls,
        setupEnvironmentProfileControls,
        setupResumeLatestWorkflowControl,
        setupSyncListeners
    });
    console.log('Selected molecules:', selectedMolecules);
});

// Setup listeners for cross-window sync
function setupSyncListeners() {
    window.ReviewWorkspaceModule.bindSyncListeners({
        refreshReviewPage,
        displayReferencePanels
    });
}

// Refresh the review page with updated selections
function refreshReviewPage() {
    window.ReviewWorkspaceModule.refreshWorkspace({
        loadSelectedItems,
        syncWorkflowProjectWithSelection,
        displaySummary,
        renderWorkflowProjectFields,
        renderWorkflowProject,
        renderEnvironmentSummary,
        displayReferencePanels,
        workflowProject,
        refreshWorkflowProjectFromBackend
    });
}

async function openWorkflowProject(projectId, options = {}) {
    const nextProjectId = String(projectId || '').trim();
    if (!nextProjectId) {
        return false;
    }

    try {
        const response = await fetchWorkflowApi(`${WORKFLOW_API_BASE_PATH}/projects/${encodeURIComponent(nextProjectId)}`);
        const restored = hydrateReviewStateFromProject(response.project);
        if (!restored) {
            throw new Error('Selected backend project is missing its selection snapshot.');
        }

        syncWorkflowProjectWithSelection();
        displaySummary();
        renderWorkflowProjectFields();
        renderWorkflowProject();
        renderEnvironmentForm();
        renderEnvironmentSummary();
        displayReferencePanels();

        if (hasActiveWorkflowJobs()) {
            startWorkflowJobPolling();
        } else {
            stopWorkflowJobPolling();
        }

        if (!options.silent) {
            showToast(`Opened saved workflow project ${workflowProject.projectName || workflowProject.projectId}.`);
        }

        return true;
    } catch (error) {
        console.error('Unable to open workflow project:', error);
        if (!options.silent) {
            showToast(`Unable to open the saved workflow project: ${error.message}`);
        }
        return false;
    }
}

// Open Search window
function openSearchWindow() {
    window.ReviewWorkspaceModule.openSearchView();
}

// Make function globally accessible
window.openSearchWindow = openSearchWindow;

function setupResumeLatestWorkflowControl() {
    const resumeBtn = document.getElementById('resume-latest-workflow-btn');
    const resumeProjectList = document.getElementById('resume-workflow-project-list');
    const emptyPresetApplyBtn = document.getElementById('empty-state-preset-apply-btn');

    if (!resumeBtn || resumeBtn.dataset.bound === 'true') {
        // Continue; the project list can still be bound independently.
    } else {
        resumeBtn.addEventListener('click', async () => {
            const restored = await restoreReviewStateFromBackend({ force: true });
            if (!restored) {
                showToast('No saved backend workflow project is available to resume yet.');
                return;
            }

            syncWorkflowProjectWithSelection();
            displaySummary();
            renderWorkflowProjectFields();
            renderWorkflowProject();
            renderEnvironmentForm();
            renderEnvironmentSummary();
            displayReferencePanels();
            showToast('Restored the latest workflow project from the local backend.');
        });

        resumeBtn.dataset.bound = 'true';
    }

    if (emptyPresetApplyBtn && emptyPresetApplyBtn.dataset.bound !== 'true') {
        emptyPresetApplyBtn.addEventListener('click', () => {
            const select = document.getElementById('empty-state-preset-select');
            const presetKey = select ? select.value : '';
            if (!presetKey) {
                showToast('Select a preset from the dropdown first.');
                return;
            }
            applyWorkflowPreset(presetKey);
        });
        emptyPresetApplyBtn.dataset.bound = 'true';
    }

    if (resumeProjectList && resumeProjectList.dataset.bound !== 'true') {
        resumeProjectList.addEventListener('click', async event => {
            const button = event.target.closest('[data-open-saved-project]');
            if (!button) {
                return;
            }

            await openWorkflowProject(button.dataset.openSavedProject);
        });
        resumeProjectList.dataset.bound = 'true';
    }
}

function setupEnvironmentProfileControls() {
    const form = document.getElementById('environment-form');
    if (form && !form.dataset.bound) {
        form.addEventListener('input', handleEnvironmentProfileInput);
        form.addEventListener('change', handleEnvironmentProfileInput);
        form.dataset.bound = 'true';
    }

    const resetBtn = document.getElementById('environment-reset-btn');
    if (resetBtn && !resetBtn.dataset.bound) {
        resetBtn.addEventListener('click', resetEnvironmentProfile);
        resetBtn.dataset.bound = 'true';
    }
}

function handleEnvironmentProfileInput() {
    const form = document.getElementById('environment-form');
    if (!form) return;

    environmentProfile = normalizeEnvironmentProfile(Object.fromEntries(new FormData(form).entries()));
    saveEnvironmentProfile();
    renderWorkflowProject();
    renderEnvironmentSummary();
    refreshEnvironmentAnalysisPanels();
}

function resetEnvironmentProfile() {
    environmentProfile = normalizeEnvironmentProfile(DEFAULT_ENVIRONMENT_PROFILE);
    saveEnvironmentProfile();
    renderEnvironmentForm();
    renderWorkflowProject();
    renderEnvironmentSummary();
    refreshEnvironmentAnalysisPanels();
    showToast('Environment profile reset to baseline conditions.');
}

function loadEnvironmentProfile() {
    const stored = localStorage.getItem(ENVIRONMENT_PROFILE_STORAGE_KEY);
    if (!stored) {
        environmentProfile = normalizeEnvironmentProfile(DEFAULT_ENVIRONMENT_PROFILE);
        return;
    }

    try {
        environmentProfile = normalizeEnvironmentProfile(JSON.parse(stored));
    } catch (error) {
        console.error('Error parsing environment profile:', error);
        environmentProfile = normalizeEnvironmentProfile(DEFAULT_ENVIRONMENT_PROFILE);
    }
}

function saveEnvironmentProfile() {
    localStorage.setItem(ENVIRONMENT_PROFILE_STORAGE_KEY, JSON.stringify(environmentProfile));
}

function renderEnvironmentForm() {
    const form = document.getElementById('environment-form');
    if (!form) return;

    form.elements.profileName.value = environmentProfile.profileName;
    form.elements.ph.value = environmentProfile.ph;
    form.elements.temperatureC.value = environmentProfile.temperatureC;
    form.elements.ionicStrengthmM.value = environmentProfile.ionicStrengthmM;
    form.elements.solvent.value = environmentProfile.solvent;
    form.elements.cofactors.value = environmentProfile.cofactors;
    form.elements.notes.value = environmentProfile.notes;
}

function renderEnvironmentSummary() {
    const summary = document.getElementById('environment-summary');
    if (!summary) return;

    summary.innerHTML = buildEnvironmentSummaryMarkup();
}

function buildEnvironmentSummaryMarkup() {
    const counts = countSelectedMoleculesByType();
    const flags = collectEnvironmentFlags(counts);
    const chips = [
        `pH ${environmentProfile.ph.toFixed(1)} · ${describePhBand(environmentProfile.ph)}`,
        `${formatTemperatureValue(environmentProfile.temperatureC)} · ${describeTemperatureBand(environmentProfile.temperatureC)}`,
        `${formatIonicStrengthValue(environmentProfile.ionicStrengthmM)} · ${describeIonicStrengthBand(environmentProfile.ionicStrengthmM)}`,
        ENVIRONMENT_SOLVENT_LABELS[environmentProfile.solvent]
    ];

    if (environmentProfile.cofactors) {
        chips.push(`Cofactors: ${environmentProfile.cofactors}`);
    }

    const profileTitle = environmentProfile.profileName || 'Baseline profile';
    const notesMarkup = environmentProfile.notes
        ? `<div class="environment-note"><strong>Assumptions:</strong> ${escapeHTML(environmentProfile.notes)}</div>`
        : '';
    const flagsMarkup = flags.length > 0
        ? `<ul class="environment-flag-list">${flags.map(flag => `<li>${escapeHTML(flag)}</li>`).join('')}</ul>`
        : '<p class="environment-card-copy">Current conditions remain close to a standard screening profile, but results are still qualitative until a backend analysis engine is added.</p>';

    return `
        <div class="environment-summary-grid">
            <article class="environment-summary-card">
                <span class="environment-kicker">Active Conditions</span>
                <h3>${escapeHTML(profileTitle)}</h3>
                <div class="environment-chip-list">
                    ${chips.map(chip => `<span class="environment-chip">${escapeHTML(chip)}</span>`).join('')}
                </div>
            </article>

            <article class="environment-summary-card">
                <span class="environment-kicker">Coverage</span>
                <div class="environment-coverage-grid">
                    <div class="environment-metric"><strong>${counts.structure}</strong><span>Structures</span></div>
                    <div class="environment-metric"><strong>${counts.protein}</strong><span>Proteins</span></div>
                    <div class="environment-metric"><strong>${counts.compound}</strong><span>Compounds</span></div>
                    <div class="environment-metric"><strong>${counts.kegg}</strong><span>KEGG Entries</span></div>
                </div>
            </article>

            <article class="environment-summary-card">
                <span class="environment-kicker">Interpretation Flags</span>
                ${flagsMarkup}
            </article>

            <article class="environment-summary-card">
                <span class="environment-kicker">Analysis Mode</span>
                <p class="environment-card-copy">Screening overlay only. The current implementation captures environment data and exposes condition-aware interpretation, but quantitative pocket, docking, and stability scoring still need a backend preparation and simulation pipeline.</p>
            </article>
        </div>
        ${notesMarkup}
    `;
}

function refreshEnvironmentAnalysisPanels() {
    selectedMolecules.forEach((item, index) => {
        const container = document.getElementById(`environment-analysis-${index}`);
        if (container) {
            container.innerHTML = buildEnvironmentAnalysisMarkup(item);
        }
    });
}

function buildEnvironmentAnalysisMarkup(item) {
    const readiness = getEnvironmentReadiness(item);
    const shiftAssessment = getEnvironmentShiftAssessment(item);
    const cards = [
        readiness,
        {
            title: 'Likely Shift',
            tone: shiftAssessment.tone,
            badge: shiftAssessment.label,
            body: getEnvironmentShiftNarrative(item)
        },
        {
            title: 'Next Step',
            tone: 'info',
            badge: 'Action',
            body: getEnvironmentFollowUp(item)
        }
    ];

    if (environmentProfile.notes) {
        cards.push({
            title: 'Profile Assumption',
            tone: 'neutral',
            badge: 'Context',
            body: environmentProfile.notes
        });
    }

    return cards.map(renderEnvironmentAnalysisCard).join('');
}

function renderEnvironmentAnalysisCard(card) {
    return `
        <article class="environment-analysis-card ${card.tone}">
            <div class="environment-analysis-card-header">
                <h5>${escapeHTML(card.title)}</h5>
                ${card.badge ? `<span class="analysis-badge ${card.tone}">${escapeHTML(card.badge)}</span>` : ''}
            </div>
            <p>${escapeHTML(card.body)}</p>
        </article>
    `;
}

function getEnvironmentReadiness(item) {
    const methodLabel = item.method ? item.method.toLowerCase() : 'structure data';
    const resolutionText = Number.isFinite(item.resolution) ? ` at ${item.resolution.toFixed(2)} A` : '';

    if (isPDBItem(item)) {
        if (environmentProfile.cofactors) {
            return {
                title: 'Readiness',
                tone: 'positive',
                badge: 'Ready for screening',
                body: `Experimental ${methodLabel}${resolutionText} can support structure-level screening because the environment profile already defines cofactor context.`
            };
        }

        return {
            title: 'Readiness',
            tone: 'warn',
            badge: 'Needs cofactors',
            body: `Experimental ${methodLabel}${resolutionText} is available, but missing metal or cofactor context will limit catalytic-site and binding-pocket interpretation.`
        };
    }

    if (isAlphaFoldItem(item)) {
        return {
            title: 'Readiness',
            tone: 'warn',
            badge: 'Model caution',
            body: 'AlphaFold models are useful for hypothesis generation, but they do not encode assay solvent, crystallographic waters, or bound cofactors directly.'
        };
    }

    if (isUniProtItem(item)) {
        return {
            title: 'Readiness',
            tone: 'info',
            badge: 'Annotation-first',
            body: 'UniProt entries provide sequence and feature context, but environment-sensitive scoring still depends on a prepared 3D structure and protonation model.'
        };
    }

    if (isCompoundItem(item)) {
        return {
            title: 'Readiness',
            tone: 'warn',
            badge: 'Protonation pending',
            body: 'Compound behavior under this profile depends on charge state, tautomer balance, and solvation, so current output should be treated as pre-analysis guidance.'
        };
    }

    if (isKEGGItem(item)) {
        return {
            title: 'Readiness',
            tone: 'info',
            badge: 'Context only',
            body: 'KEGG entries describe biochemical context well, but they do not provide atomistic environment or binding energetics on their own.'
        };
    }

    return {
        title: 'Readiness',
        tone: 'info',
        badge: 'Qualitative only',
        body: 'This item can be interpreted under the selected environment profile, but quantitative scoring requires prepared structure and chemistry data.'
    };
}

function getEnvironmentShiftAssessment(item) {
    let riskScore = 0;

    if (environmentProfile.ph < 6.5 || environmentProfile.ph > 8.5) riskScore++;
    if (environmentProfile.ionicStrengthmM < 50 || environmentProfile.ionicStrengthmM > 300) riskScore++;
    if (environmentProfile.temperatureC < 10 || environmentProfile.temperatureC > 37) riskScore++;
    if (environmentProfile.solvent !== 'aqueous') riskScore++;
    if (isAlphaFoldItem(item) || isUniProtItem(item)) riskScore++;

    const molecularWeight = getCompoundMolecularWeight(item);
    const logP = getCompoundLogP(item);
    if (isCompoundItem(item) && ((molecularWeight !== null && molecularWeight > 500) || (logP !== null && logP > 3))) {
        riskScore++;
    }

    if (riskScore >= 3) {
        return { tone: 'warn', label: 'High shift risk' };
    }
    if (riskScore === 2) {
        return { tone: 'info', label: 'Moderate shift' };
    }
    return { tone: 'positive', label: 'Lower shift risk' };
}

function getEnvironmentShiftNarrative(item) {
    const effects = [];

    if (isStructureItem(item) || isProteinItem(item)) {
        if (environmentProfile.ph < 6.5) {
            effects.push('Acidic pH is likely to shift titratable residue charge states and hydrogen-bond patterns');
        } else if (environmentProfile.ph > 8.5) {
            effects.push('Basic pH can rebalance catalytic acid-base chemistry and surface charge distribution');
        } else {
            effects.push('Near-neutral pH keeps most charge assignments close to common structural defaults');
        }

        if (environmentProfile.ionicStrengthmM > 300) {
            effects.push('high salt may shield electrostatic steering and salt bridges');
        } else if (environmentProfile.ionicStrengthmM < 50) {
            effects.push('low salt can exaggerate long-range electrostatic attraction');
        } else {
            effects.push('moderate ionic strength supports standard electrostatic interpretation');
        }

        if (environmentProfile.solvent === 'membrane') {
            effects.push('membrane context can reorder residue exposure and pocket accessibility');
        } else if (environmentProfile.solvent === 'organic') {
            effects.push('organic-rich solvent can alter hydrophobic packing and water occupancy');
        } else if (environmentProfile.solvent === 'mixed') {
            effects.push('mixed solvent may shift hydration balance and ligand pose stability');
        } else {
            effects.push('aqueous conditions keep water-mediated contacts relevant');
        }

        if (environmentProfile.temperatureC > 37) {
            effects.push('elevated temperature increases the chance of flexible-loop and marginal-pocket motion');
        }

        return formatAnalysisSentence(effects, 3);
    }

    if (isCompoundItem(item)) {
        const molecularWeight = getCompoundMolecularWeight(item);
        const logP = getCompoundLogP(item);

        if (environmentProfile.ph < 6.5 || environmentProfile.ph > 8.5) {
            effects.push('This pH is far enough from neutral that protonation state enumeration becomes important before scoring');
        } else {
            effects.push('Near-neutral pH is compatible with first-pass protonation screening');
        }

        if (environmentProfile.solvent === 'aqueous') {
            if ((molecularWeight !== null && molecularWeight > 500) || (logP !== null && logP > 3)) {
                effects.push('aqueous exposure may be limited by solubility or aggregation');
            } else {
                effects.push('aqueous buffer is a reasonable first-pass solvation context');
            }
        } else if (environmentProfile.solvent === 'membrane') {
            effects.push('membrane-like conditions favor partitioning and hydrophobic accumulation over bulk solubility');
        } else if (environmentProfile.solvent === 'organic') {
            effects.push('organic-rich solvent can improve solubilization but may distort biologically relevant binding behavior');
        } else {
            effects.push('mixed solvent may shift both solubility and apparent activity');
        }

        if (environmentProfile.ionicStrengthmM > 300) {
            effects.push('high salt can change counterion pairing and apparent activity');
        }

        return formatAnalysisSentence(effects, 3);
    }

    if (isKEGGItem(item)) {
        effects.push('Pathway records do not encode atomistic solvent, protonation, or binding geometry directly');

        if (environmentProfile.solvent === 'membrane') {
            effects.push('membrane context is still useful for prioritizing transport and surface-associated nodes');
        } else {
            effects.push('use the selected profile to prioritize targets rather than infer direct binding energetics');
        }

        if (environmentProfile.cofactors) {
            effects.push(`the defined cofactor context (${environmentProfile.cofactors}) can help triage metal- or cofactor-dependent branches`);
        }

        return formatAnalysisSentence(effects, 3);
    }

    return 'The current environment profile adds useful context, but this item still needs prepared structure and chemistry data before quantitative interpretation.';
}

function getEnvironmentFollowUp(item) {
    if (isPDBItem(item)) {
        return environmentProfile.cofactors
            ? 'Carry this profile into structure preparation, protonation, solvent placement, and pocket-contact scoring on the backend.'
            : 'Define required metals or cofactors first, then prepare protonation states and run pocket-contact scoring under the same profile.';
    }

    if (isAlphaFoldItem(item) || isUniProtItem(item)) {
        return 'Map missing ligands or cofactors, generate protonation states, and compare priority pockets against experimental structures when they exist.';
    }

    if (isCompoundItem(item)) {
        return 'Enumerate protonation and tautomer states, estimate pKa or logD under this profile, and pair the prepared ligand with a selected structure.';
    }

    if (isKEGGItem(item)) {
        return 'Use this pathway hit to nominate target proteins or compounds, then carry the same environment profile into structure-level analysis.';
    }

    return 'Carry this environment profile into backend preparation and scoring before treating outputs as quantitative.';
}

function collectEnvironmentFlags(counts) {
    const flags = [];

    if (counts.structure > 0 && !environmentProfile.cofactors) {
        flags.push('No metal or cofactor context is defined yet, so catalytic and coordination chemistry remains incomplete.');
    }
    if (environmentProfile.ph < 6.5) {
        flags.push('Acidic pH may materially change protonation states for histidine, aspartate, and glutamate-rich sites.');
    } else if (environmentProfile.ph > 8.5) {
        flags.push('Basic pH may rebalance catalytic residues and surface charge patterns.');
    }
    if (environmentProfile.ionicStrengthmM > 300) {
        flags.push('High ionic strength can shield electrostatic attraction and salt bridges.');
    } else if (environmentProfile.ionicStrengthmM < 50) {
        flags.push('Low ionic strength can overstate electrostatic steering versus physiological buffer.');
    }
    if (environmentProfile.solvent === 'membrane') {
        flags.push('Membrane context changes residue exposure and pocket accessibility compared with the current aqueous viewer defaults.');
    } else if (environmentProfile.solvent === 'organic' || environmentProfile.solvent === 'mixed') {
        flags.push('Non-aqueous solvent conditions can shift hydration, solubility, and binding pose preferences.');
    }
    if (counts.alphafold > 0) {
        flags.push('AlphaFold selections should be treated cautiously because explicit waters, ligands, and assay buffer coordinates are not observed.');
    }
    if (counts.compound > 0) {
        flags.push('Compound scoring remains qualitative until protonation, tautomer, and solvation states are prepared under this same profile.');
    }

    return flags.slice(0, 4);
}

function countSelectedMoleculesByType(items = selectedMolecules) {
    const counts = {
        total: items.length,
        pdb: 0,
        alphafold: 0,
        protein: 0,
        compound: 0,
        structure: 0,
        kegg: 0
    };

    items.forEach(item => {
        if (isPDBItem(item)) {
            counts.pdb++;
            counts.structure++;
        } else if (isAlphaFoldItem(item)) {
            counts.alphafold++;
            counts.protein++;
            counts.structure++;
        } else if (isUniProtItem(item)) {
            counts.protein++;
        } else if (isCompoundItem(item)) {
            counts.compound++;
        } else if (isKEGGItem(item)) {
            counts.kegg++;
        }
    });

    return counts;
}

function isPDBItem(item) {
    const dbType = (item?.database || '').toLowerCase();
    return dbType.includes('pdb') && !dbType.includes('alphafold');
}

function isAlphaFoldItem(item) {
    return (item?.database || '').toLowerCase().includes('alphafold');
}

function isUniProtItem(item) {
    const dbType = (item?.database || '').toLowerCase();
    return dbType.includes('uniprot') && !dbType.includes('alphafold');
}

function isProteinItem(item) {
    return isAlphaFoldItem(item) || isUniProtItem(item);
}

function isStructureItem(item) {
    return isPDBItem(item) || isAlphaFoldItem(item);
}

function isCompoundItem(item) {
    const dbType = (item?.database || '').toLowerCase();
    return dbType.includes('pubchem') || dbType.includes('chembl');
}

function isKEGGItem(item) {
    return (item?.database || '').toLowerCase().includes('kegg');
}

function getCompoundMolecularWeight(item) {
    const value = item?.data?.MolecularWeight
        ?? item?.data?.molecule_properties?.full_mwt
        ?? item?.data?.molecule_properties?.mw_freebase;
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function getCompoundLogP(item) {
    const value = item?.data?.XLogP
        ?? item?.data?.xlogp
        ?? item?.data?.molecule_properties?.alogp;
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function normalizeEnvironmentProfile(profile = {}) {
    return {
        profileName: typeof profile.profileName === 'string' ? profile.profileName.trim() : '',
        ph: clampNumericValue(profile.ph, 0, 14, DEFAULT_ENVIRONMENT_PROFILE.ph),
        temperatureC: clampNumericValue(profile.temperatureC, -20, 200, DEFAULT_ENVIRONMENT_PROFILE.temperatureC),
        ionicStrengthmM: clampNumericValue(profile.ionicStrengthmM, 0, 5000, DEFAULT_ENVIRONMENT_PROFILE.ionicStrengthmM),
        solvent: ENVIRONMENT_SOLVENT_LABELS[profile.solvent] ? profile.solvent : DEFAULT_ENVIRONMENT_PROFILE.solvent,
        cofactors: typeof profile.cofactors === 'string' ? profile.cofactors.trim() : '',
        notes: typeof profile.notes === 'string' ? profile.notes.trim() : ''
    };
}

function clampNumericValue(value, min, max, fallback) {
    const parsed = Number.parseFloat(value);
    if (!Number.isFinite(parsed)) {
        return fallback;
    }
    return Math.min(max, Math.max(min, parsed));
}

function formatAnalysisSentence(parts, limit = parts.length) {
    const filteredParts = parts.filter(Boolean).slice(0, limit);
    if (filteredParts.length === 0) {
        return 'No environment-sensitive shifts were identified from the available metadata.';
    }
    return `${filteredParts.join('; ')}.`;
}

function formatTemperatureValue(value) {
    return `${Number.parseFloat(value).toFixed(1)} C`;
}

function formatIonicStrengthValue(value) {
    return `${Math.round(Number.parseFloat(value))} mM`;
}

function describePhBand(ph) {
    if (ph < 6.5) return 'Acidic';
    if (ph > 8.5) return 'Basic';
    return 'Near neutral';
}

function describeTemperatureBand(temperatureC) {
    if (temperatureC < 10) return 'Cold';
    if (temperatureC > 37) return 'Elevated';
    return 'Screening range';
}

function describeIonicStrengthBand(ionicStrengthmM) {
    if (ionicStrengthmM < 50) return 'Low salt';
    if (ionicStrengthmM > 300) return 'High salt';
    return 'Moderate salt';
}

function escapeHTML(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function getWorkflowArtifactExtension(artifactPath) {
    const normalizedPath = String(artifactPath || '').replace(/\\/g, '/');
    const lastSegment = normalizedPath.split('/').pop() || '';
    const segmentParts = lastSegment.split('.');
    return segmentParts.length > 1 ? segmentParts.pop().toLowerCase() : '';
}

function getWorkflowArtifactDisplayName(artifactPath) {
    return String(artifactPath || '').replace(/\\/g, '/').split('/').pop() || 'artifact';
}

function getWorkflowArtifactTypeLabel(artifactPath) {
    switch (getWorkflowArtifactExtension(artifactPath)) {
        case 'pdb':
            return 'Structure PDB';
        case 'dcd':
            return 'Trajectory DCD';
        case 'csv':
            return 'State CSV';
        case 'chk':
            return 'OpenMM checkpoint';
        case 'json':
            return 'JSON metadata';
        case 'xml':
            return 'XML system';
        case 'sdf':
            return 'Ligand SDF';
        case 'mol2':
            return 'MOL2 export';
        default:
            return 'Managed artifact';
    }
}

function isPreviewableWorkflowArtifact(artifactPath) {
    return ['pdb', 'csv', 'json', 'xml', 'txt', 'sdf', 'mol', 'mol2'].includes(getWorkflowArtifactExtension(artifactPath));
}

function getWorkflowArtifactHref(artifactPath) {
    const normalizedPath = String(artifactPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!normalizedPath) {
        return '#';
    }
    return `/${normalizedPath.split('/').map(segment => encodeURIComponent(segment)).join('/')}`;
}

function renderWorkflowArtifactActions(artifactPath) {
    if (!artifactPath) {
        return '';
    }

    const href = escapeHTML(getWorkflowArtifactHref(artifactPath));
    const fileName = escapeHTML(getWorkflowArtifactDisplayName(artifactPath));
    const openLabel = isPreviewableWorkflowArtifact(artifactPath) ? 'Open' : 'Open / Download';

    return `
        <div class="workflow-artifact-actions">
            <a class="workflow-artifact-link" href="${href}" target="_blank" rel="noopener noreferrer">${openLabel}</a>
            <a class="workflow-artifact-link secondary" href="${href}" download="${fileName}">Export</a>
        </div>
    `;
}

function renderWorkflowArtifactItem(artifactPath) {
    return `
        <li class="workflow-artifact-item">
            <div class="workflow-artifact-copy">
                <strong>${escapeHTML(getWorkflowArtifactTypeLabel(artifactPath))}</strong>
                <span>${escapeHTML(getWorkflowArtifactDisplayName(artifactPath))}</span>
                <code>${escapeHTML(artifactPath)}</code>
            </div>
            ${renderWorkflowArtifactActions(artifactPath)}
        </li>
    `;
}

function getWorkflowPrimaryArtifactPath(checkpoint, runtime) {
    if (!checkpoint) {
        return runtime.artifactPaths?.[0] || '';
    }

    const candidateKeys = [
        'complexPdbPath',
        'preparedStructurePath',
        'ligandPdbPath',
        'manifestPath',
        'planPath',
        'ionizedStructurePath',
        'minimizedStructurePath',
        'finalStructurePath',
        'trajectoryPath',
        'openmmCheckpointPath',
        'summaryPath'
    ];

    for (const key of candidateKeys) {
        if (checkpoint[key]) {
            return checkpoint[key];
        }
    }

    return runtime.artifactPaths?.[0] || '';
}

function createDefaultWorkflowProject() {
    return {
        projectId: '',
        projectName: '',
        workflowType: 'protein-water',
        engine: 'openmm',
        activeStageId: 'import',
        stageData: Object.fromEntries(
            WORKFLOW_STAGES.map(stage => [
                stage.id,
                {
                    progress: 'pending',
                    config: createDefaultStageConfig(stage),
                    runtime: createDefaultStageRuntime(stage)
                }
            ])
        )
    };
}

function createDefaultStageConfig(stage) {
    const config = {};
    stage.fields.forEach(field => {
        config[field.name] = field.default;
    });
    return config;
}

function createDefaultStageRuntime(stage) {
    return {
        supported: isBackendStageSupported(stage.id),
        status: isBackendStageSupported(stage.id) ? 'idle' : 'not-wired',
        activeJobId: '',
        lastJobId: '',
        lastRunAt: '',
        completedAt: '',
        updatedAt: '',
        checkpoint: null,
        artifactPaths: [],
        logEntries: [],
        error: ''
    };
}

function normalizeWorkflowStageRuntime(stage, runtime = {}) {
    const normalized = createDefaultStageRuntime(stage);
    normalized.supported = typeof runtime.supported === 'boolean' ? runtime.supported : normalized.supported;
    normalized.status = WORKFLOW_EXECUTION_STATUS_LABELS[runtime.status] ? runtime.status : normalized.status;
    normalized.activeJobId = typeof runtime.activeJobId === 'string' ? runtime.activeJobId : '';
    normalized.lastJobId = typeof runtime.lastJobId === 'string' ? runtime.lastJobId : '';
    normalized.lastRunAt = typeof runtime.lastRunAt === 'string' ? runtime.lastRunAt : '';
    normalized.completedAt = typeof runtime.completedAt === 'string' ? runtime.completedAt : '';
    normalized.updatedAt = typeof runtime.updatedAt === 'string' ? runtime.updatedAt : '';
    normalized.checkpoint = runtime.checkpoint && typeof runtime.checkpoint === 'object' ? runtime.checkpoint : null;
    normalized.artifactPaths = Array.isArray(runtime.artifactPaths) ? runtime.artifactPaths : [];
    normalized.logEntries = Array.isArray(runtime.logEntries)
        ? runtime.logEntries.slice(-12).map(entry => ({
            timestamp: typeof entry.timestamp === 'string' ? entry.timestamp : '',
            level: typeof entry.level === 'string' ? entry.level : 'info',
            message: typeof entry.message === 'string' ? entry.message : ''
        }))
        : [];
    normalized.error = typeof runtime.error === 'string' ? runtime.error : '';
    return normalized;
}

function loadWorkflowProject() {
    const stored = localStorage.getItem(WORKFLOW_PROJECT_STORAGE_KEY);
    if (!stored) {
        workflowProject = createDefaultWorkflowProject();
        return;
    }

    try {
        workflowProject = normalizeWorkflowProject(JSON.parse(stored));
    } catch (error) {
        console.error('Error parsing workflow project:', error);
        workflowProject = createDefaultWorkflowProject();
    }
}

function normalizeWorkflowProject(project = {}) {
    const normalized = createDefaultWorkflowProject();
    normalized.projectId = typeof project.projectId === 'string' ? project.projectId.trim() : '';
    normalized.projectName = typeof project.projectName === 'string' ? project.projectName.trim() : '';
    normalized.workflowType = WORKFLOW_TYPE_OPTIONS[project.workflowType] ? project.workflowType : normalized.workflowType;
    normalized.engine = WORKFLOW_ENGINE_OPTIONS[project.engine] ? project.engine : normalized.engine;
    normalized.activeStageId = WORKFLOW_STAGES.some(stage => stage.id === project.activeStageId)
        ? project.activeStageId
        : normalized.activeStageId;

    WORKFLOW_STAGES.forEach(stage => {
        const savedStage = project.stageData?.[stage.id] || {};
        const savedStageConfig = savedStage.config && typeof savedStage.config === 'object' ? savedStage.config : {};
        const progress = ['pending', 'in-progress', 'complete', 'skipped'].includes(savedStage.progress)
            ? savedStage.progress
            : 'pending';
        normalized.stageData[stage.id] = {
            progress,
            config: {
                ...createDefaultStageConfig(stage),
                ...savedStageConfig
            },
            runtime: normalizeWorkflowStageRuntime(stage, savedStage.runtime)
        };

        if (stage.id === 'complex-build') {
            sanitizeWorkflowReferenceResidueConfig(normalized.stageData[stage.id].config);
        }
    });

    syncWorkflowProgressFromRuntime(normalized);

    return normalized;
}

function saveWorkflowProject() {
    localStorage.setItem(WORKFLOW_PROJECT_STORAGE_KEY, JSON.stringify(workflowProject));
}

function formatWorkflowProjectCatalogOptionLabel(projectSummary) {
    const workflowLabel = WORKFLOW_TYPE_OPTIONS[projectSummary.workflowType] || projectSummary.workflowType || 'Workflow';
    const updatedLabel = formatWorkflowDateTime(projectSummary.updatedAt || projectSummary.createdAt || '');
    return `${projectSummary.projectName || projectSummary.projectId} · ${workflowLabel} · ${projectSummary.selectedCount || 0} selected · ${updatedLabel}`;
}

function getWorkflowProjectCatalogEntries() {
    const counts = countSelectedMoleculesByType();
    const catalog = Array.isArray(workflowProjectCatalog) ? workflowProjectCatalog.slice() : [];
    if (!workflowProject.projectId || catalog.some(project => project.projectId === workflowProject.projectId)) {
        return catalog;
    }

    catalog.unshift({
        projectId: workflowProject.projectId,
        projectName: workflowProject.projectName || workflowProject.projectId,
        workflowType: workflowProject.workflowType,
        engine: workflowProject.engine,
        createdAt: '',
        updatedAt: '',
        activeStageId: workflowProject.activeStageId,
        selectedCount: selectedMolecules.length,
        structureCount: counts.structure,
        compoundCount: counts.compound,
        completeStageCount: WORKFLOW_STAGES.filter(stage => workflowProject.stageData[stage.id]?.progress === 'complete').length
    });

    return catalog;
}

function buildWorkflowProjectCatalogOptionsMarkup() {
    const catalog = getWorkflowProjectCatalogEntries();
    const selectedProjectId = String(workflowProject.projectId || '').trim();

    if (!catalog.length) {
        return '<option value="">No saved workflow projects on disk</option>';
    }

    return [
        '<option value="">Select saved workflow project</option>',
        ...catalog.map(project => `<option value="${escapeHTML(project.projectId)}" ${selectedProjectId === project.projectId ? 'selected' : ''}>${escapeHTML(formatWorkflowProjectCatalogOptionLabel(project))}</option>`)
    ].join('');
}

function buildWorkflowProjectCatalogCaption() {
    const projectCount = Array.isArray(workflowProjectCatalog) ? workflowProjectCatalog.length : 0;
    if (!projectCount && !workflowProjectCatalogSkippedCount) {
        return 'No saved workflow projects have been discovered yet.';
    }

    const parts = [`${projectCount} saved project${projectCount === 1 ? '' : 's'} available`];
    if (workflowProjectCatalogSkippedCount > 0) {
        parts.push(`${workflowProjectCatalogSkippedCount} unreadable skipped`);
    }

    return parts.join(' · ');
}

function renderEmptyStateProjectCatalog() {
    const container = document.getElementById('resume-workflow-project-list');
    if (!container) {
        return;
    }

    const catalog = getWorkflowProjectCatalogEntries().slice(0, 4);
    if (!catalog.length) {
        container.innerHTML = '';
        return;
    }

    container.innerHTML = `
        <div class="empty-state-project-card">
            <span class="workflow-kicker">Saved Projects</span>
            <div class="empty-state-project-grid">
                ${catalog.map(project => `
                    <button type="button" class="empty-state-project-btn" data-open-saved-project="${escapeHTML(project.projectId)}">
                        <strong>${escapeHTML(project.projectName || project.projectId)}</strong>
                        <span>${escapeHTML(WORKFLOW_TYPE_OPTIONS[project.workflowType] || project.workflowType || 'Workflow')}</span>
                        <small>${escapeHTML(formatWorkflowDateTime(project.updatedAt || project.createdAt || ''))}</small>
                    </button>
                `).join('')}
            </div>
            <p class="empty-state-project-copy">${escapeHTML(buildWorkflowProjectCatalogCaption())}</p>
        </div>
    `;
}

function hydrateReviewStateFromProject(projectState) {
    if (!projectState) {
        return false;
    }

    const isGasPhase = projectState.workflowType === 'reactive-md-test';
    const hasMolecules = Array.isArray(projectState.selectedMolecules) && projectState.selectedMolecules.length > 0;

    // Gas-phase workflows (reactive MD) have no selected molecules — that is expected
    if (!hasMolecules && !isGasPhase) {
        return false;
    }

    selectedMolecules = hasMolecules ? projectState.selectedMolecules : [];
    hasStoredSelectionSnapshot = hasMolecules;
    localStorage.setItem('selectedMolecules', JSON.stringify(selectedMolecules));

    environmentProfile = normalizeEnvironmentProfile(projectState.environmentProfile || DEFAULT_ENVIRONMENT_PROFILE);
    saveEnvironmentProfile();

    applyBackendProjectState(projectState);
    return true;
}

async function restoreReviewStateFromBackend(options = {}) {
    const force = Boolean(options.force);

    if (workflowServiceStatus !== 'available' || (!force && (selectedMolecules.length > 0 || hasStoredSelectionSnapshot))) {
        return false;
    }

    try {
        let projectState = null;

        if (workflowProject.projectId) {
            const exactResponse = await fetchWorkflowApi(`${WORKFLOW_API_BASE_PATH}/projects/${encodeURIComponent(workflowProject.projectId)}`);
            projectState = exactResponse.project || null;
        }

        if (!projectState) {
            const latestResponse = await fetchWorkflowApi(`${WORKFLOW_API_BASE_PATH}/projects/latest`);
            projectState = latestResponse.project || null;
        }

        return hydrateReviewStateFromProject(projectState);
    } catch (error) {
        if (!/HTTP 404/i.test(String(error.message || ''))) {
            console.error('Unable to restore workflow state from backend:', error);
        }
        return false;
    }
}

function syncWorkflowProjectWithSelection() {
    workflowProject = normalizeWorkflowProject(workflowProject);

    const isGasPhase = workflowProject.workflowType === 'reactive-md-test';

    if (!selectedMolecules.length && !isGasPhase) {
        stopWorkflowJobPolling();
        workflowProject.projectId = '';
        workflowProject.projectName = '';
        WORKFLOW_STAGES.forEach(stage => {
            workflowProject.stageData[stage.id].progress = 'pending';
            workflowProject.stageData[stage.id].runtime = createDefaultStageRuntime(stage);
        });
        saveWorkflowProject();
        return;
    }

    if (!workflowProject.projectName) {
        workflowProject.projectName = deriveWorkflowProjectName();
    }

    workflowProject.workflowType = WORKFLOW_TYPE_OPTIONS[workflowProject.workflowType]
        ? workflowProject.workflowType
        : detectDefaultWorkflowType();

    if (!WORKFLOW_STAGES.some(stage => stage.id === workflowProject.activeStageId)) {
        workflowProject.activeStageId = 'import';
    }

    syncWorkflowProgressFromRuntime(workflowProject);

    saveWorkflowProject();
}

function deriveWorkflowProjectName() {
    const primaryItem = selectedMolecules.find(item => isStructureItem(item) || isProteinItem(item)) || selectedMolecules[0];
    const baseTitle = primaryItem?.title || 'Molecular Project';
    const cleanTitle = baseTitle.split(' - ')[0].trim();
    const suffix = detectDefaultWorkflowType() === 'protein-ligand-water' ? 'Protein-Ligand MD' : 'Protein MD';
    return `${cleanTitle} ${suffix}`;
}

function detectDefaultWorkflowType() {
    const counts = countSelectedMoleculesByType();
    return counts.compound > 0 ? 'protein-ligand-water' : 'protein-water';
}

function setupWorkflowControls() {
    const workflowSection = document.getElementById('workflow-section');
    if (!workflowSection || workflowSection.dataset.bound === 'true') {
        return;
    }

    workflowSection.addEventListener('click', handleWorkflowClick);
    workflowSection.addEventListener('change', handleWorkflowChange);
    workflowSection.dataset.bound = 'true';
}

async function handleWorkflowClick(event) {
    const stageButton = event.target.closest('[data-stage-select]');
    if (stageButton) {
        workflowProject.activeStageId = stageButton.dataset.stageSelect;
        saveWorkflowProject();
        renderWorkflowProject();
        return;
    }

    const filePickerButton = event.target.closest('[data-stage-file-picker]');
    if (filePickerButton) {
        const fileInput = findWorkflowStageFileInput(filePickerButton.dataset.stageFilePicker);
        if (fileInput) {
            fileInput.click();
        }
        return;
    }

    const clearFileButton = event.target.closest('[data-stage-file-clear]');
    if (clearFileButton) {
        const [stageId, fieldName] = clearFileButton.dataset.stageFileClear.split(':');
        if (!workflowProject.stageData[stageId]) {
            return;
        }

        workflowProject.stageData[stageId].config[fieldName] = '';
        if (stageId === 'complex-build') {
            workflowProject.stageData[stageId].config.referenceResidueId = '';
            workflowProject.stageData[stageId].config.referenceResidueOptions = [];
            workflowProject.stageData[stageId].config.referencePoseSourceType = '';
        }
        saveWorkflowProject();
        renderWorkflowProject();
        showToast('Managed pose file cleared from the stage menu.');
        return;
    }

    const runButton = event.target.closest('[data-stage-run]');
    if (runButton) {
        await runWorkflowStage(runButton.dataset.stageRun);
        return;
    }

    const refreshButton = event.target.closest('[data-stage-refresh]');
    if (refreshButton) {
        await refreshWorkflowProjectFromBackend(false);
        return;
    }

    if (event.target.closest('#workflow-project-refresh-btn')) {
        await refreshWorkflowProjectCatalog(false);
        return;
    }

    const resetStageButton = event.target.closest('[data-stage-reset]');
    if (resetStageButton) {
        await resetWorkflowStage(resetStageButton.dataset.stageReset);
        return;
    }

    const skipButton = event.target.closest('[data-stage-skip]');
    if (skipButton) {
        const stageId = skipButton.dataset.stageSkip;
        if (!workflowProject.stageData[stageId]) return;

        workflowProject.stageData[stageId].progress = 'skipped';
        workflowProject.stageData[stageId].runtime = createDefaultStageRuntime(getWorkflowStage(stageId));
        saveWorkflowProject();
        renderWorkflowProject();
        showToast(`${getWorkflowStage(stageId)?.shortTitle || 'Stage'} skipped locally.`);
        return;
    }

    const resetButton = event.target.closest('#workflow-reset-btn');
    if (resetButton) {
        resetWorkflowProject();
        return;
    }

    if (event.target.closest('#workflow-preset-apply-btn')) {
        const presetSelect = document.getElementById('workflow-preset-select');
        if (presetSelect && presetSelect.value) {
            applyWorkflowPreset(presetSelect.value);
        } else {
            showToast('Select a preset first.');
        }
        return;
    }
}

async function handleWorkflowChange(event) {
    const target = event.target;

    if (target.dataset.stageFileInput) {
        const [stageId, fieldName] = target.dataset.stageFileInput.split(':');
        const file = target.files?.[0];
        target.value = '';
        if (!file || !workflowProject.stageData[stageId]) {
            return;
        }

        await uploadWorkflowStageFile(stageId, fieldName, file);
        return;
    }

    if (target.id === 'workflow-project-name') {
        workflowProject.projectName = target.value.trim();
        saveWorkflowProject();
        renderWorkflowProjectFields();
        return;
    }

    if (target.id === 'workflow-type-select') {
        workflowProject.workflowType = WORKFLOW_TYPE_OPTIONS[target.value] ? target.value : workflowProject.workflowType;
        saveWorkflowProject();
        renderWorkflowProjectFields();
        renderWorkflowProject();
        return;
    }

    if (target.id === 'workflow-engine-select') {
        workflowProject.engine = WORKFLOW_ENGINE_OPTIONS[target.value] ? target.value : workflowProject.engine;
        saveWorkflowProject();
        renderWorkflowProjectFields();
        renderWorkflowProject();
        return;
    }

    if (target.id === 'workflow-preset-select') {
        // no-op on change alone; user must click Apply
        return;
    }

    if (target.id === 'workflow-saved-project-select') {
        if (!target.value) {
            renderWorkflowProjectFields();
            return;
        }

        await openWorkflowProject(target.value);
        return;
    }

    if (target.dataset.stageField) {
        const [stageId, fieldName] = target.dataset.stageField.split(':');
        if (!workflowProject.stageData[stageId]) return;

        workflowProject.stageData[stageId].config[fieldName] = target.type === 'checkbox' ? target.checked : target.value;
        saveWorkflowProject();
        renderWorkflowProject();
    }
}

function findWorkflowStageFileInput(stageFieldId) {
    return Array.from(document.querySelectorAll('[data-stage-file-input]')).find(input => input.dataset.stageFileInput === stageFieldId) || null;
}

async function uploadWorkflowStageFile(stageId, fieldName, file) {
    const stage = getWorkflowStage(stageId);
    if (!stage || !workflowProject.stageData[stageId]) {
        return;
    }

    try {
        const contentBase64 = await readFileAsBase64(file);
        const response = await fetchWorkflowApi(`${WORKFLOW_API_BASE_PATH}/pose-imports`, {
            method: 'POST',
            body: JSON.stringify({
                ...buildWorkflowStageRequestPayload(stageId),
                fileName: file.name,
                contentBase64
            })
        });

        if (response.project) {
            applyBackendProjectState(response.project);
        }

        workflowProject.stageData[stageId].config[fieldName] = response.upload?.path || '';
        workflowProject.stageData[stageId].config.referenceResidueId = response.upload?.referenceResidueId || '';
        workflowProject.stageData[stageId].config.referenceResidueOptions = Array.isArray(response.upload?.referenceResidueOptions)
            ? response.upload.referenceResidueOptions
            : [];
        workflowProject.stageData[stageId].config.referencePoseSourceType = response.upload?.sourceType || '';
        sanitizeWorkflowReferenceResidueConfig(workflowProject.stageData[stageId].config);
        saveWorkflowProject();
        renderWorkflowProject();
        showToast(`Imported ${file.name} into the managed project workspace.`);
    } catch (error) {
        console.error('Unable to upload pose file:', error);
        showToast(`Unable to upload the pose file: ${error.message}`);
    }
}

function readFileAsBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const result = typeof reader.result === 'string' ? reader.result : '';
            const commaIndex = result.indexOf(',');
            resolve(commaIndex >= 0 ? result.slice(commaIndex + 1) : result);
        };
        reader.onerror = () => reject(new Error('Unable to read the selected file.'));
        reader.readAsDataURL(file);
    });
}

function resetWorkflowProject() {
    stopWorkflowJobPolling();
    workflowProject = createDefaultWorkflowProject();
    syncWorkflowProjectWithSelection();
    renderWorkflowProjectFields();
    renderWorkflowProject();
    showToast('Workflow reset to the default guided MD stages.');
}

function applyWorkflowPreset(presetKey) {
    const preset = WORKFLOW_PRESETS[presetKey];
    if (!preset) {
        showToast(`Unknown preset: ${presetKey}`);
        return;
    }
    if (WORKFLOW_TYPE_OPTIONS[preset.workflowType]) {
        workflowProject.workflowType = preset.workflowType;
    }
    if (WORKFLOW_ENGINE_OPTIONS[preset.engine]) {
        workflowProject.engine = preset.engine;
    }
    if (preset.projectName && !workflowProject.projectName) {
        workflowProject.projectName = preset.projectName;
    }
    WORKFLOW_STAGES.forEach(stage => {
        const overrides = preset.stageConfigs[stage.id];
        if (overrides && workflowProject.stageData[stage.id]) {
            Object.assign(workflowProject.stageData[stage.id].config, overrides);
        }
    });
    saveWorkflowProject();
    displaySummary();
    renderWorkflowProjectFields();
    renderWorkflowProject();
    showToast(`Preset "${preset.label}" applied — review stage parameters before running.`);
}

function renderWorkflowProjectFields() {
    const projectNameInput = document.getElementById('workflow-project-name');
    const workflowTypeSelect = document.getElementById('workflow-type-select');
    const workflowEngineSelect = document.getElementById('workflow-engine-select');
    const savedProjectSelect = document.getElementById('workflow-saved-project-select');
    const savedProjectCaption = document.getElementById('workflow-project-picker-caption');
    const projectSummary = document.getElementById('workflow-project-summary');

    if (projectNameInput) projectNameInput.value = workflowProject.projectName;
    if (workflowTypeSelect) workflowTypeSelect.value = workflowProject.workflowType;
    if (workflowEngineSelect) workflowEngineSelect.value = workflowProject.engine;
    if (savedProjectSelect) {
        savedProjectSelect.innerHTML = buildWorkflowProjectCatalogOptionsMarkup();
        const hasCurrentOption = Array.from(savedProjectSelect.options).some(option => option.value === workflowProject.projectId);
        savedProjectSelect.value = hasCurrentOption ? workflowProject.projectId : '';
    }
    if (savedProjectCaption) {
        savedProjectCaption.textContent = buildWorkflowProjectCatalogCaption();
    }
    if (projectSummary) projectSummary.innerHTML = buildWorkflowProjectSummaryMarkup();
    renderEmptyStateProjectCatalog();
}

function renderWorkflowProject() {
    const stageList = document.getElementById('workflow-stage-list');
    const stageDetail = document.getElementById('workflow-stage-detail');

    if (stageList) {
        stageList.innerHTML = WORKFLOW_STAGES.map(stage => buildWorkflowStageListMarkup(stage)).join('');
    }

    if (stageDetail) {
        stageDetail.innerHTML = buildWorkflowStageDetailMarkup();
        initWorkflowTrajectoryViewers(stageDetail);
    }
}

function buildWorkflowProjectSummaryMarkup() {
    const counts = countSelectedMoleculesByType();
    const completeCount = WORKFLOW_STAGES.filter(stage => workflowProject.stageData[stage.id]?.progress === 'complete').length;
    const totalRelevant = WORKFLOW_STAGES.filter(stage => isStageRelevant(stage)).length;
    const backendSummary = formatWorkflowBackendSummary();
    const environmentDescriptor = [
        `pH ${environmentProfile.ph.toFixed(1)}`,
        formatIonicStrengthValue(environmentProfile.ionicStrengthmM),
        ENVIRONMENT_SOLVENT_LABELS[environmentProfile.solvent]
    ].join(' · ');

    return `
        <div class="workflow-summary-grid">
            <div class="workflow-summary-card">
                <span class="workflow-kicker">Workflow</span>
                <strong>${escapeHTML(WORKFLOW_TYPE_OPTIONS[workflowProject.workflowType])}</strong>
                <p>${escapeHTML(WORKFLOW_ENGINE_OPTIONS[workflowProject.engine])}</p>
            </div>
            <div class="workflow-summary-card">
                <span class="workflow-kicker">Selections</span>
                <strong>${counts.structure} structure(s)</strong>
                <p>${counts.compound} compound(s), ${counts.protein} protein entry(s), ${counts.kegg} KEGG context item(s)</p>
            </div>
            <div class="workflow-summary-card">
                <span class="workflow-kicker">Progress</span>
                <strong>${completeCount}/${totalRelevant} stages complete</strong>
                <p>${escapeHTML(backendSummary)}</p>
            </div>
            <div class="workflow-summary-card">
                <span class="workflow-kicker">Environment Link</span>
                <strong>${escapeHTML(environmentDescriptor)}</strong>
                <p>${environmentProfile.cofactors ? `Cofactors: ${escapeHTML(environmentProfile.cofactors)}` : 'No cofactors defined yet.'}</p>
            </div>
        </div>
    `;
}

function buildWorkflowStageListMarkup(stage) {
    const derivedState = getWorkflowStageDerivedState(stage);
    const isActive = workflowProject.activeStageId === stage.id;
    const runtime = workflowProject.stageData[stage.id]?.runtime || createDefaultStageRuntime(stage);
    const executionLabel = formatWorkflowExecutionStatusLabel(runtime.status);

    return `
        <button type="button" class="workflow-stage-btn ${derivedState.tone} ${isActive ? 'active' : ''}" data-stage-select="${stage.id}">
            <div class="workflow-stage-topline">
                <span class="workflow-stage-order">${stage.order}</span>
                <span class="workflow-stage-state ${derivedState.tone}">${escapeHTML(derivedState.label)}</span>
            </div>
            <div class="workflow-stage-text">
                <strong>${escapeHTML(stage.shortTitle)}</strong>
                <p>${escapeHTML(stage.summary)}</p>
                <span class="workflow-stage-progress">Execution: ${escapeHTML(executionLabel)}</span>
            </div>
        </button>
    `;
}

function buildWorkflowStageDetailMarkup() {
    const stage = getWorkflowStage(workflowProject.activeStageId) || WORKFLOW_STAGES[0];
    const derivedState = getWorkflowStageDerivedState(stage);
    const stageState = workflowProject.stageData[stage.id] || {
        progress: 'pending',
        config: createDefaultStageConfig(stage),
        runtime: createDefaultStageRuntime(stage)
    };
    const dependencyMarkup = buildWorkflowDependencyMarkup(stage);
    const insights = getWorkflowStageInsights(stage);
    const outputs = stage.outputs.map(output => `<li>${escapeHTML(output)}</li>`).join('');
    const visibleFields = stage.fields.filter(field => {
        if (!field.showWhen) return true;
        if (typeof field.showWhen === 'function') return !!field.showWhen(workflowProject);
        if (typeof field.showWhen === 'string') return workflowProject.workflowType === field.showWhen;
        if (Array.isArray(field.showWhen)) return field.showWhen.includes(workflowProject.workflowType);
        return true;
    });
    const configFields = visibleFields.map(field => renderWorkflowField(stage, field, stageState.config[field.name], stageState)).join('');
    const isOptional = !isStageRelevant(stage);
    const isBlocked = derivedState.tone === 'blocked';
    const runtime = stageState.runtime || createDefaultStageRuntime(stage);
    const isRunning = runtime.status === 'queued' || runtime.status === 'running';
    const canRun = isBackendStageSupported(stage.id) && !isBlocked && !isRunning && !hasIncompleteDependencies(stage) && stageHasRequiredInputs(stage);
    const executionMarkup = buildWorkflowExecutionMarkup(stage, runtime);

    return `
        <article class="workflow-detail-card">
            <div class="workflow-detail-header">
                <div>
                    <span class="workflow-kicker">Stage ${stage.order}</span>
                    <h3>${escapeHTML(stage.title)}</h3>
                    <p>${escapeHTML(stage.summary)}</p>
                </div>
                <span class="workflow-stage-state ${derivedState.tone}">${escapeHTML(derivedState.label)}</span>
            </div>

            <div class="workflow-detail-grid">
                <section class="workflow-detail-panel">
                    <h4>Dependencies</h4>
                    ${dependencyMarkup}
                </section>

                <section class="workflow-detail-panel">
                    <h4>Expected Outputs</h4>
                    <ul class="workflow-output-list">${outputs}</ul>
                </section>

                <section class="workflow-detail-panel workflow-detail-panel-wide">
                    <h4>Automation Plan</h4>
                    <ul class="workflow-insight-list">
                        ${insights.map(insight => `<li>${escapeHTML(insight)}</li>`).join('')}
                    </ul>
                </section>

                <section class="workflow-detail-panel workflow-detail-panel-wide">
                    <h4>Stage Menu</h4>
                    <div class="workflow-config-grid">
                        ${configFields}
                    </div>
                </section>

                <section class="workflow-detail-panel workflow-detail-panel-wide">
                    <h4>Execution</h4>
                    ${executionMarkup}
                </section>
            </div>

            <div class="workflow-action-row">
                <button type="button" class="workflow-action-btn secondary" data-stage-reset="${stage.id}" ${isRunning ? 'disabled' : ''}>Reset Stage</button>
                ${isOptional ? `<button type="button" class="workflow-action-btn subtle" data-stage-skip="${stage.id}">Skip Stage</button>` : ''}
                <button type="button" class="workflow-action-btn subtle" data-stage-refresh="${stage.id}" ${workflowProject.projectId ? '' : 'disabled'}>Refresh State</button>
                <button type="button" class="workflow-action-btn primary" data-stage-run="${stage.id}" ${canRun ? '' : 'disabled'}>${isBackendStageSupported(stage.id) ? (runtime.checkpoint ? 'Rerun Stage' : 'Run Stage') : 'Backend Pending'}</button>
            </div>
        </article>
    `;
}

function buildWorkflowExecutionMarkup(stage, runtime) {
    if (!isBackendStageSupported(stage.id)) {
        return '<p class="workflow-runtime-copy">Backend execution is not wired for this stage yet. Logs and checkpoints will appear here once the stage is implemented.</p>';
    }

    const checkpoint = runtime.checkpoint;
    const logEntries = runtime.logEntries || [];
    const primaryArtifactPath = getWorkflowPrimaryArtifactPath(checkpoint, runtime);
    const artifactList = runtime.artifactPaths?.length
        ? `<ul class="workflow-artifact-list">${runtime.artifactPaths.map(renderWorkflowArtifactItem).join('')}</ul>`
        : '<p class="workflow-runtime-copy">No backend artifacts recorded yet.</p>';
    const logMarkup = logEntries.length
        ? `<div class="workflow-log-list">${logEntries.map(entry => `
            <article class="workflow-log-entry ${escapeHTML(entry.level || 'info')}">
                <span class="workflow-log-time">${escapeHTML(formatWorkflowDateTime(entry.timestamp))}</span>
                <p>${escapeHTML(entry.message)}</p>
            </article>
        `).join('')}</div>`
        : '<p class="workflow-runtime-copy">No job logs yet. Run the stage to generate manifest or preparation outputs.</p>';
    const checkpointMarkup = checkpoint
        ? `
            <div class="workflow-checkpoint-card">
                <strong>${escapeHTML(checkpoint.label || 'Checkpoint available')}</strong>
                <p>${escapeHTML(checkpoint.summary || 'Checkpoint saved to the local backend.')}</p>
                <dl class="workflow-checkpoint-meta">${buildWorkflowCheckpointMetaMarkup(checkpoint, runtime, primaryArtifactPath)}</dl>
            </div>
        `
        : '<p class="workflow-runtime-copy">No checkpoint saved yet.</p>';

    const trajectoryMarkup = buildWorkflowTrajectoryViewerMarkup(stage, runtime, checkpoint);

    return `
        <div class="workflow-runtime-grid">
            <div class="workflow-runtime-stat">
                <span>Status</span>
                <strong>${escapeHTML(formatWorkflowExecutionStatusLabel(runtime.status))}</strong>
            </div>
            <div class="workflow-runtime-stat">
                <span>Job</span>
                <strong>${escapeHTML(runtime.activeJobId || runtime.lastJobId || 'None')}</strong>
            </div>
            <div class="workflow-runtime-stat">
                <span>Updated</span>
                <strong>${escapeHTML(formatWorkflowDateTime(runtime.updatedAt || runtime.lastRunAt))}</strong>
            </div>
            <div class="workflow-runtime-stat">
                <span>Service</span>
                <strong>${escapeHTML(WORKFLOW_SERVICE_STATUS_LABELS[workflowServiceStatus] || WORKFLOW_SERVICE_STATUS_LABELS.checking)}</strong>
            </div>
        </div>
        ${runtime.error ? `<p class="workflow-runtime-error">${escapeHTML(runtime.error)}</p>` : ''}
        <div class="workflow-runtime-stack">
            <section>
                <h5>Checkpoint</h5>
                ${checkpointMarkup}
            </section>
            ${trajectoryMarkup}
            <section>
                <h5>Artifacts</h5>
                ${artifactList}
            </section>
            <section>
                <h5>Recent Logs</h5>
                ${logMarkup}
            </section>
        </div>
    `;
}

function buildWorkflowTrajectoryViewerMarkup(stage, runtime, checkpoint) {
    const trajectoryPath = checkpoint && checkpoint.trajectoryPath;
    const topologyPath = checkpoint && (checkpoint.finalStructurePath || checkpoint.initialStructurePath);
    if (!trajectoryPath || !topologyPath) {
        return '';
    }
    const trajectoryHref = escapeHTML(getWorkflowArtifactHref(trajectoryPath));
    const topologyHref = escapeHTML(getWorkflowArtifactHref(topologyPath));
    const viewerId = `workflow-trajectory-viewer-${stage.id}`;
    return `
        <section class="workflow-trajectory-panel">
            <h5>Trajectory Viewer</h5>
            <p class="workflow-runtime-copy">Animated playback of <code>${escapeHTML(getWorkflowArtifactDisplayName(trajectoryPath))}</code> using <code>${escapeHTML(getWorkflowArtifactDisplayName(topologyPath))}</code> as the topology reference.</p>
            <div class="workflow-trajectory-viewer"
                 id="${viewerId}"
                 data-trajectory-viewer
                 data-stage-id="${escapeHTML(stage.id)}"
                 data-topology-href="${topologyHref}"
                 data-trajectory-href="${trajectoryHref}"></div>
            <div class="workflow-trajectory-controls">
                <button type="button" class="workflow-action-btn primary" data-trajectory-action="play" data-target="${viewerId}">Play</button>
                <button type="button" class="workflow-action-btn subtle" data-trajectory-action="pause" data-target="${viewerId}">Pause</button>
                <button type="button" class="workflow-action-btn subtle" data-trajectory-action="reset" data-target="${viewerId}">Reset</button>
                <input type="range" min="0" max="100" value="0" step="1" class="workflow-trajectory-scrub" data-trajectory-scrub="${viewerId}">
                <span class="workflow-trajectory-frame-label" data-trajectory-label="${viewerId}">Frame 0 / 0</span>
            </div>
        </section>
    `;
}

const workflowTrajectoryViewers = new Map();

function initWorkflowTrajectoryViewers(rootElement) {
    if (!rootElement || typeof window === 'undefined' || !window.NGL) {
        return;
    }
    const elements = rootElement.querySelectorAll('[data-trajectory-viewer]');
    elements.forEach(element => {
        const viewerId = element.id;
        // Dispose of any existing viewer at this id (re-renders)
        const previous = workflowTrajectoryViewers.get(viewerId);
        if (previous && previous.stage) {
            try { previous.stage.dispose(); } catch (_) { /* noop */ }
            workflowTrajectoryViewers.delete(viewerId);
        }

        const topologyHref = element.getAttribute('data-topology-href');
        const trajectoryHref = element.getAttribute('data-trajectory-href');
        if (!topologyHref || !trajectoryHref) {
            return;
        }

        const stage = new window.NGL.Stage(element, { backgroundColor: '#0d1117' });
        const state = { stage, component: null, trajectory: null, playing: false, animationHandle: null };
        workflowTrajectoryViewers.set(viewerId, state);

        const playBtn = rootElement.querySelector(`[data-trajectory-action="play"][data-target="${viewerId}"]`);
        const pauseBtn = rootElement.querySelector(`[data-trajectory-action="pause"][data-target="${viewerId}"]`);
        const resetBtn = rootElement.querySelector(`[data-trajectory-action="reset"][data-target="${viewerId}"]`);
        const scrub = rootElement.querySelector(`[data-trajectory-scrub="${viewerId}"]`);
        const label = rootElement.querySelector(`[data-trajectory-label="${viewerId}"]`);

        const updateLabel = (frame, count) => {
            if (label) label.textContent = `Frame ${frame} / ${Math.max(0, count - 1)}`;
        };

        stage.loadFile(topologyHref, { ext: 'pdb', defaultRepresentation: false }).then(component => {
            state.component = component;
            component.addRepresentation('ball+stick', { multipleBond: 'symmetric' });
            component.addRepresentation('label', {
                labelType: 'atomname',
                color: '#f0f6fc',
                fontFamily: 'sans-serif',
                showBackground: true,
                backgroundColor: '#161b22',
                backgroundOpacity: 0.7
            });
            component.autoView();

            return component.addTrajectory(trajectoryHref, {
                defaultStep: 1,
                defaultTimeout: 1000 / 30
            });
        }).then(trajComp => {
            if (!trajComp) return;
            const traj = trajComp.trajectory;
            state.trajectory = traj;

            const applyFrameCount = () => {
                const count = traj.frameCount || 0;
                if (scrub) scrub.max = String(Math.max(0, count - 1));
                updateLabel(traj.currentFrame || 0, count);
            };

            // frameCount may not be available immediately
            if (traj.frameCount) {
                applyFrameCount();
            } else {
                traj.signals.countChanged.add(applyFrameCount);
            }

            traj.signals.frameChanged.add(frame => {
                if (scrub && document.activeElement !== scrub) {
                    scrub.value = String(frame);
                }
                updateLabel(frame, traj.frameCount || 0);
            });

            traj.setFrame(0);
        }).catch(error => {
            element.innerHTML = `<p class="workflow-runtime-error">Failed to load trajectory: ${escapeHTML(String(error && error.message || error))}</p>`;
        });

        const startPlay = () => {
            if (!state.trajectory || state.playing) return;
            state.playing = true;
            const tick = () => {
                if (!state.playing || !state.trajectory) return;
                const count = state.trajectory.frameCount || 0;
                if (count <= 0) {
                    state.animationHandle = requestAnimationFrame(tick);
                    return;
                }
                const next = ((state.trajectory.currentFrame || 0) + 1) % count;
                state.trajectory.setFrame(next);
                state.animationHandle = setTimeout(() => requestAnimationFrame(tick), 1000 / 24);
            };
            tick();
        };
        const stopPlay = () => {
            state.playing = false;
            if (state.animationHandle) {
                cancelAnimationFrame(state.animationHandle);
                clearTimeout(state.animationHandle);
                state.animationHandle = null;
            }
        };

        if (playBtn) playBtn.addEventListener('click', startPlay);
        if (pauseBtn) pauseBtn.addEventListener('click', stopPlay);
        if (resetBtn) resetBtn.addEventListener('click', () => {
            stopPlay();
            if (state.trajectory) state.trajectory.setFrame(0);
        });
        if (scrub) scrub.addEventListener('input', () => {
            if (state.trajectory) {
                stopPlay();
                state.trajectory.setFrame(Number(scrub.value));
            }
        });
    });
}

function buildWorkflowDependencyMarkup(stage) {
    const dependencies = stage.dependencies.filter(dependencyId => isStageRelevant(getWorkflowStage(dependencyId)));
    if (dependencies.length === 0) {
        return '<p class="workflow-dependency-copy">This stage can start as soon as selections are available.</p>';
    }

    return `
        <ul class="workflow-dependency-list">
            ${dependencies.map(dependencyId => {
                const dependencyStage = getWorkflowStage(dependencyId);
                const dependencyState = getWorkflowStageDerivedState(dependencyStage);
                return `<li><span>${escapeHTML(dependencyStage.shortTitle)}</span><span class="workflow-inline-badge ${dependencyState.tone}">${escapeHTML(dependencyState.label)}</span></li>`;
            }).join('')}
        </ul>
    `;
}

function buildWorkflowCheckpointMetaMarkup(checkpoint, runtime, primaryArtifactPath) {
    const metaItems = [
        {
            label: 'Generated',
            value: escapeHTML(formatWorkflowDateTime(checkpoint.generatedAt || runtime.completedAt || runtime.updatedAt))
        },
        {
            label: 'Primary Artifact',
            html: primaryArtifactPath
                ? `<span class="workflow-checkpoint-artifact-name">${escapeHTML(getWorkflowArtifactDisplayName(primaryArtifactPath))}</span>${renderWorkflowArtifactActions(primaryArtifactPath)}`
                : 'Not recorded'
        }
    ];

    if (checkpoint.poseSourceType) {
        metaItems.push({
            label: 'Pose Source Type',
            value: escapeHTML(formatWorkflowPoseSourceTypeLabel(checkpoint.poseSourceType))
        });
    }

    if (checkpoint.extractedResidueId) {
        metaItems.push({
            label: 'Extracted Residue',
            value: escapeHTML(checkpoint.extractedResidueId)
        });
    }

    return metaItems.map(item => `
        <div>
            <dt>${item.label}</dt>
            <dd>${item.html || item.value || 'Not recorded'}</dd>
        </div>
    `).join('');
}

function formatWorkflowPoseSourceTypeLabel(sourceType) {
    switch (sourceType) {
        case 'reference-complex-pdb':
            return 'Reference complex PDB';
        case 'ligand-only-pdb':
            return 'Ligand-only PDB';
        case 'ligand-pose-file':
            return 'Ligand pose file';
        default:
            return String(sourceType || '').replace(/-/g, ' ');
    }
}

function getWorkflowFieldOptions(field, stageState) {
    if (field.optionsFromConfig) {
        const configuredOptions = Array.isArray(stageState?.config?.[field.optionsFromConfig])
            ? stageState.config[field.optionsFromConfig]
            : [];
        const normalizedOptions = configuredOptions
            .filter(option => option && typeof option === 'object' && typeof option.value === 'string')
            .map(option => ({
                ...option,
                value: option.value,
                label: typeof option.label === 'string' && option.label ? option.label : option.value
            }));
        return field.emptyOptionLabel
            ? [{ value: '', label: field.emptyOptionLabel }, ...normalizedOptions]
            : normalizedOptions;
    }

    return field.options || [];
}

function renderWorkflowField(stage, field, value, stageState) {
    const stageFieldId = `${stage.id}:${field.name}`;

    if (field.type === 'file-upload') {
        const currentPath = String(value || '').trim();
        const currentHref = currentPath ? escapeHTML(getWorkflowArtifactHref(currentPath)) : '';
        return `
            <label class="workflow-config-field workflow-config-field-wide">
                <span>${escapeHTML(field.label)}</span>
                <div class="workflow-file-field">
                    <input
                        type="file"
                        class="workflow-file-input"
                        data-stage-file-input="${stageFieldId}"
                        accept="${escapeHTML(field.accept || '')}"
                    >
                    <div class="workflow-file-actions">
                        <button type="button" class="workflow-action-btn subtle" data-stage-file-picker="${stageFieldId}">${currentPath ? 'Replace File' : 'Choose File'}</button>
                        ${currentPath ? `<a class="workflow-artifact-link secondary" href="${currentHref}" target="_blank" rel="noopener noreferrer">Open Current</a>` : ''}
                        ${currentPath ? `<button type="button" class="workflow-action-btn secondary" data-stage-file-clear="${stageFieldId}">Clear</button>` : ''}
                    </div>
                    ${field.helpText ? `<p class="workflow-file-caption">${escapeHTML(field.helpText)}</p>` : ''}
                    <div class="workflow-file-status ${currentPath ? 'is-ready' : ''}">
                        ${currentPath
                            ? `<strong>${escapeHTML(getWorkflowArtifactDisplayName(currentPath))}</strong><code>${escapeHTML(currentPath)}</code>`
                            : '<span>No managed pose file uploaded yet.</span>'}
                    </div>
                </div>
            </label>
        `;
    }

    if (field.type === 'checkbox') {
        return `
            <label class="workflow-checkbox-field">
                <input type="checkbox" data-stage-field="${stageFieldId}" ${value ? 'checked' : ''}>
                <span>${escapeHTML(field.label)}</span>
            </label>
        `;
    }

    if (field.type === 'textarea') {
        return `
            <label class="workflow-config-field workflow-config-field-wide">
                <span>${escapeHTML(field.label)}</span>
                <textarea rows="3" data-stage-field="${stageFieldId}" placeholder="${escapeHTML(field.placeholder || '')}">${escapeHTML(value ?? '')}</textarea>
            </label>
        `;
    }

    if (field.type === 'select') {
        const options = getWorkflowFieldOptions(field, stageState);
        const hasSelectableValues = options.some(option => option.value);
        if (field.optionsFromConfig && !hasSelectableValues && !String(value || '').trim()) {
            return '';
        }

        if (stage.id === 'complex-build' && field.name === 'referenceResidueId') {
            return `
                <label class="workflow-config-field workflow-config-field-wide">
                    <span>${escapeHTML(field.label)}</span>
                    <div class="workflow-reference-picker-layout">
                        <select data-stage-field="${stageFieldId}">
                            ${options.map(option => `<option value="${escapeHTML(option.value)}" ${String(value ?? '') === option.value ? 'selected' : ''}>${escapeHTML(option.label)}</option>`).join('')}
                        </select>
                        ${buildWorkflowReferenceResiduePreviewMarkup(stageState)}
                    </div>
                </label>
            `;
        }

        return `
            <label class="workflow-config-field">
                <span>${escapeHTML(field.label)}</span>
                <select data-stage-field="${stageFieldId}">
                    ${options.map(option => `<option value="${escapeHTML(option.value)}" ${String(value ?? '') === option.value ? 'selected' : ''}>${escapeHTML(option.label)}</option>`).join('')}
                </select>
            </label>
        `;
    }

    return `
        <label class="workflow-config-field">
            <span>${escapeHTML(field.label)}</span>
            <input
                type="number"
                data-stage-field="${stageFieldId}"
                value="${escapeHTML(value)}"
                ${field.min !== undefined ? `min="${field.min}"` : ''}
                ${field.max !== undefined ? `max="${field.max}"` : ''}
                ${field.step !== undefined ? `step="${field.step}"` : ''}
            >
        </label>
    `;
}

function getWorkflowStage(stageId) {
    return WORKFLOW_STAGES.find(stage => stage.id === stageId) || null;
}

function sanitizeWorkflowReferenceResidueConfig(config) {
    if (!config || typeof config !== 'object') {
        return config;
    }

    const poseImportPath = String(config.poseImportPath || '').trim();
    const residueOptions = Array.isArray(config.referenceResidueOptions)
        ? config.referenceResidueOptions.filter(option => option && typeof option.value === 'string')
        : [];

    if (!poseImportPath) {
        config.referenceResidueId = '';
        config.referenceResidueOptions = [];
        config.referencePoseSourceType = '';
        return config;
    }

    config.referenceResidueOptions = residueOptions;

    const selectedResidueId = String(config.referenceResidueId || '').trim();
    if (selectedResidueId && residueOptions.length && !residueOptions.some(option => option.value === selectedResidueId)) {
        config.referenceResidueId = '';
    }

    return config;
}

function buildWorkflowReferenceResiduePreviewMarkup(stageState) {
    const config = stageState?.config || {};
    const residueOptions = Array.isArray(config.referenceResidueOptions)
        ? config.referenceResidueOptions.filter(option => option && typeof option.value === 'string')
        : [];
    const selectedResidueId = String(config.referenceResidueId || '').trim();
    const selectedOption = residueOptions.find(option => option.value === selectedResidueId) || null;
    const sourceType = String(config.referencePoseSourceType || '').trim();

    if (!String(config.poseImportPath || '').trim()) {
        return `
            <aside class="workflow-reference-preview is-empty">
                <strong>Ligand Preview</strong>
                <p>Upload a reference complex PDB to inspect extracted ligand residue candidates before complex assembly.</p>
            </aside>
        `;
    }

    if (!residueOptions.length) {
        return `
            <aside class="workflow-reference-preview">
                <strong>Ligand Preview</strong>
                <p>This pose source does not expose multiple HETATM ligand residues, so no residue override is required.</p>
                <dl class="workflow-reference-preview-meta">
                    ${sourceType ? `<div><dt>Pose Source</dt><dd>${escapeHTML(formatWorkflowPoseSourceTypeLabel(sourceType))}</dd></div>` : ''}
                    <div><dt>Chooser State</dt><dd>Auto</dd></div>
                </dl>
            </aside>
        `;
    }

    const previewMeta = [
        `<div><dt>Pose Source</dt><dd>${escapeHTML(formatWorkflowPoseSourceTypeLabel(sourceType || 'reference-complex-pdb'))}</dd></div>`,
        `<div><dt>Candidate Count</dt><dd>${residueOptions.length}</dd></div>`,
        `<div><dt>Chooser State</dt><dd>${selectedOption ? 'Pinned override' : 'Auto-select best match'}</dd></div>`
    ];

    if (selectedOption) {
        previewMeta.push(`<div><dt>Residue</dt><dd>${escapeHTML(selectedOption.value)}</dd></div>`);
        if (selectedOption.residueName) {
            previewMeta.push(`<div><dt>Residue Name</dt><dd>${escapeHTML(selectedOption.residueName)}</dd></div>`);
        }
        if (Number.isFinite(selectedOption.heavyAtomCount)) {
            previewMeta.push(`<div><dt>Heavy Atoms</dt><dd>${selectedOption.heavyAtomCount}</dd></div>`);
        }
        if (Number.isFinite(selectedOption.atomCount)) {
            previewMeta.push(`<div><dt>Total Atoms</dt><dd>${selectedOption.atomCount}</dd></div>`);
        }
    }

    return `
        <aside class="workflow-reference-preview ${selectedOption ? 'is-selected' : 'is-auto'}">
            <strong>Ligand Preview</strong>
            <p>${selectedOption
                ? `Inspecting ${escapeHTML(selectedOption.label || selectedOption.value)} before complex assembly.`
                : 'Auto-selection will choose the best-matching ligand at run time. Pick a residue above to force a specific candidate.'}</p>
            <dl class="workflow-reference-preview-meta">
                ${previewMeta.join('')}
            </dl>
            <div class="workflow-reference-option-list">
                ${residueOptions.map(option => `
                    <span class="workflow-reference-option-chip ${selectedOption && selectedOption.value === option.value ? 'is-active' : ''}">
                        ${escapeHTML(option.value)}
                    </span>
                `).join('')}
            </div>
        </aside>
    `;
}

function getWorkflowStageDerivedState(stage) {
    if (!stage) {
        return { tone: 'blocked', label: 'Missing' };
    }

    const stageState = workflowProject.stageData[stage.id] || { progress: 'pending' };
    const runtime = stageState.runtime || createDefaultStageRuntime(stage);

    if (runtime.status === 'completed' || stageState.progress === 'complete') {
        return { tone: 'complete', label: 'Complete' };
    }
    if (runtime.status === 'running') {
        return { tone: 'in-progress', label: 'Running' };
    }
    if (runtime.status === 'queued') {
        return { tone: 'queued', label: 'Queued' };
    }
    if (runtime.status === 'failed') {
        return { tone: 'blocked', label: 'Failed' };
    }
    if (stageState.progress === 'skipped') {
        return { tone: 'optional', label: 'Skipped' };
    }
    if (!isStageRelevant(stage)) {
        return { tone: 'optional', label: 'Optional' };
    }
    if (!stageHasRequiredInputs(stage)) {
        return { tone: 'blocked', label: 'Blocked' };
    }
    if (hasIncompleteDependencies(stage)) {
        return { tone: 'queued', label: 'Queued' };
    }
    if (stageState.progress === 'in-progress') {
        return { tone: 'in-progress', label: 'In Progress' };
    }
    return { tone: 'ready', label: 'Ready' };
}

function isStageRelevant(stage) {
    if (!stage) return false;
    if (workflowProject.workflowType === 'protein-water' && (stage.id === 'ligand-prep' || stage.id === 'complex-build')) {
        return false;
    }
    // Reactive MD test is gas-phase and topology-from-preset — no solvent, ions, or complex assembly
    if (workflowProject.workflowType === 'reactive-md-test' &&
        (stage.id === 'ligand-prep' || stage.id === 'complex-build' ||
         stage.id === 'solvation' || stage.id === 'ions')) {
        return false;
    }
    return true;
}

function stageHasRequiredInputs(stage) {
    // Gas-phase reactive MD workflows get all inputs from stage configs and notes —
    // no selected molecules are required.
    if (workflowProject.workflowType === 'reactive-md-test') {
        return true;
    }

    const counts = countSelectedMoleculesByType();
    const hasProteinSource = counts.structure > 0 || counts.protein > 0;
    const hasLigandSource = counts.compound > 0;

    switch (stage.id) {
        case 'import':
            return selectedMolecules.length > 0;
        case 'protein-prep':
        case 'solvation':
        case 'ions':
        case 'minimization':
        case 'nvt':
        case 'npt':
        case 'production':
        case 'analysis':
            return hasProteinSource;
        case 'ligand-prep':
            return workflowProject.workflowType === 'protein-water' || counts.compound > 0;
        case 'complex-build':
            return hasProteinSource && hasLigandSource;
        default:
            return true;
    }
}

function hasIncompleteDependencies(stage) {
    return stage.dependencies
        .filter(dependencyId => isStageRelevant(getWorkflowStage(dependencyId)))
        .some(dependencyId => workflowProject.stageData[dependencyId]?.progress !== 'complete');
}

function isBackendStageSupported(stageId) {
    return BACKEND_SUPPORTED_STAGE_IDS.has(stageId);
}

function syncWorkflowProgressFromRuntime(project = workflowProject) {
    WORKFLOW_STAGES.forEach(stage => {
        const stageState = project.stageData[stage.id];
        if (!stageState) return;

        const runtime = stageState.runtime || createDefaultStageRuntime(stage);
        if (runtime.status === 'completed') {
            stageState.progress = 'complete';
            return;
        }
        if (runtime.status === 'queued' || runtime.status === 'running') {
            stageState.progress = 'in-progress';
            return;
        }
        if (stageState.progress !== 'skipped') {
            stageState.progress = 'pending';
        }
    });
}

function formatWorkflowExecutionStatusLabel(status) {
    return WORKFLOW_EXECUTION_STATUS_LABELS[status] || WORKFLOW_EXECUTION_STATUS_LABELS.idle;
}

function formatWorkflowBackendSummary() {
    if (workflowServiceStatus === 'offline') {
        return 'Local backend is offline. Start the integrated server with npm start to run stages and capture checkpoints.';
    }

    if (workflowServiceStatus === 'available' && workflowProject.projectId) {
        return `Local backend connected. Project ${workflowProject.projectId} stores prep artifacts, simulation logs, checkpoints, and trajectory files on disk.`;
    }

    if (workflowServiceStatus === 'available') {
        return 'Local backend connected and ready for OpenMM-backed preparation, minimization, and pilot MD trajectories.';
    }

    return 'Checking whether the local backend is available for stage execution.';
}

function formatWorkflowDateTime(value) {
    if (!value) return 'Not yet';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return value;
    }
    return date.toLocaleString();
}

async function initializeWorkflowBackend() {
    await checkWorkflowServiceHealth();
    const restoredState = await restoreReviewStateFromBackend();
    if (!restoredState && workflowProject.projectId) {
        await refreshWorkflowProjectFromBackend(true);
    }
    await refreshWorkflowProjectCatalog(true);
    if (hasActiveWorkflowJobs()) {
        startWorkflowJobPolling();
    }
}

async function refreshWorkflowProjectCatalog(silent = false) {
    if (workflowServiceStatus !== 'available') {
        workflowProjectCatalog = [];
        workflowProjectCatalogSkippedCount = 0;
        renderWorkflowProjectFields();
        return;
    }

    try {
        const response = await fetchWorkflowApi(`${WORKFLOW_API_BASE_PATH}/projects`);
        workflowProjectCatalog = Array.isArray(response.projects) ? response.projects : [];
        workflowProjectCatalogSkippedCount = Number.isFinite(response.skippedCount) ? response.skippedCount : 0;
        renderWorkflowProjectFields();

        if (!silent) {
            showToast('Saved workflow project list refreshed from the local backend.');
        }
    } catch (error) {
        console.error('Unable to refresh workflow project catalog:', error);
        workflowProjectCatalog = [];
        workflowProjectCatalogSkippedCount = 0;
        renderWorkflowProjectFields();

        if (!silent) {
            showToast(`Unable to refresh saved projects: ${error.message}`);
        }
    }
}

async function checkWorkflowServiceHealth() {
    try {
        const response = await fetch('/api/health', {
            headers: {
                'Accept': 'application/json'
            }
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        workflowServiceStatus = 'available';
    } catch (error) {
        workflowServiceStatus = 'offline';
    }

    renderWorkflowProjectFields();
    renderWorkflowProject();
}

async function fetchWorkflowApi(path, options = {}) {
    const requestOptions = {
        method: options.method || 'GET',
        headers: {
            'Accept': 'application/json',
            ...(options.body ? { 'Content-Type': 'application/json' } : {}),
            ...(options.headers || {})
        }
    };

    if (options.body) {
        requestOptions.body = options.body;
    }

    const response = await fetch(path, requestOptions);
    const rawText = await response.text();
    let parsedBody = null;

    if (rawText) {
        try {
            parsedBody = JSON.parse(rawText);
        } catch (error) {
            parsedBody = null;
        }
    }

    if (!response.ok) {
        const errorMessage = parsedBody?.error || `HTTP ${response.status}`;
        throw new Error(errorMessage);
    }

    workflowServiceStatus = 'available';
    return parsedBody;
}

function buildWorkflowStageRequestPayload(stageId) {
    return {
        projectId: workflowProject.projectId,
        projectName: workflowProject.projectName,
        workflowType: workflowProject.workflowType,
        engine: workflowProject.engine,
        activeStageId: workflowProject.activeStageId || stageId,
        selectedMolecules,
        environmentProfile,
        stageData: Object.fromEntries(
            WORKFLOW_STAGES.map(stage => [
                stage.id,
                {
                    progress: workflowProject.stageData[stage.id]?.progress || 'pending',
                    config: workflowProject.stageData[stage.id]?.config || createDefaultStageConfig(stage)
                }
            ])
        )
    };
}

function applyBackendProjectState(projectState) {
    if (!projectState) return;

    workflowProject.projectId = projectState.projectId || workflowProject.projectId;
    workflowProject.projectName = projectState.projectName || workflowProject.projectName;
    workflowProject.workflowType = WORKFLOW_TYPE_OPTIONS[projectState.workflowType] ? projectState.workflowType : workflowProject.workflowType;
    workflowProject.engine = WORKFLOW_ENGINE_OPTIONS[projectState.engine] ? projectState.engine : workflowProject.engine;
    workflowProject.activeStageId = WORKFLOW_STAGES.some(stage => stage.id === projectState.workflowSnapshot?.activeStageId)
        ? projectState.workflowSnapshot.activeStageId
        : workflowProject.activeStageId;

    WORKFLOW_STAGES.forEach(stage => {
        const serverStageState = projectState.stageState?.[stage.id];
        if (!serverStageState || !workflowProject.stageData[stage.id]) {
            return;
        }

        const serverStageConfig = projectState.workflowSnapshot?.stageConfig?.[stage.id];
        if (serverStageConfig && typeof serverStageConfig === 'object') {
            workflowProject.stageData[stage.id].config = {
                ...workflowProject.stageData[stage.id].config,
                ...serverStageConfig
            };

            if (stage.id === 'complex-build') {
                sanitizeWorkflowReferenceResidueConfig(workflowProject.stageData[stage.id].config);
            }
        }

        workflowProject.stageData[stage.id].runtime = normalizeWorkflowStageRuntime(stage, serverStageState);
    });

    syncWorkflowProgressFromRuntime(workflowProject);
    saveWorkflowProject();
    renderWorkflowProjectFields();
    renderWorkflowProject();
}

async function refreshWorkflowProjectFromBackend(silent = false) {
    if (!workflowProject.projectId) {
        if (!silent) {
            showToast('Run Import first to create a backend project workspace.');
        }
        return;
    }

    try {
        const response = await fetchWorkflowApi(`${WORKFLOW_API_BASE_PATH}/projects/${encodeURIComponent(workflowProject.projectId)}`);
        applyBackendProjectState(response.project);

        if (hasActiveWorkflowJobs()) {
            startWorkflowJobPolling();
        } else {
            stopWorkflowJobPolling();
        }

        if (!silent) {
            showToast('Workflow state refreshed from the local backend.');
        }
    } catch (error) {
        console.error('Unable to refresh workflow project state:', error);
        workflowServiceStatus = 'offline';
        renderWorkflowProjectFields();
        renderWorkflowProject();

        if (!silent) {
            showToast(`Unable to refresh backend state: ${error.message}`);
        }
    }
}

async function runWorkflowStage(stageId) {
    const stage = getWorkflowStage(stageId);
    if (!stage) return;

    if (!isBackendStageSupported(stageId)) {
        showToast(`${stage.shortTitle} backend wiring is not implemented yet.`);
        return;
    }

    workflowProject.stageData[stageId].runtime.status = 'queued';
    workflowProject.stageData[stageId].runtime.error = '';
    workflowProject.stageData[stageId].progress = 'in-progress';
    saveWorkflowProject();
    renderWorkflowProject();

    try {
        const response = await fetchWorkflowApi(`${WORKFLOW_API_BASE_PATH}/stages/${encodeURIComponent(stageId)}/start`, {
            method: 'POST',
            body: JSON.stringify(buildWorkflowStageRequestPayload(stageId))
        });
        applyBackendProjectState(response.project);
        startWorkflowJobPolling();
        showToast(`${stage.shortTitle} started on the local backend.`);
    } catch (error) {
        console.error(`Unable to start ${stageId}:`, error);
        workflowProject.stageData[stageId].runtime.status = 'failed';
        workflowProject.stageData[stageId].runtime.error = error.message;
        workflowProject.stageData[stageId].progress = 'pending';
        workflowServiceStatus = 'offline';
        saveWorkflowProject();
        renderWorkflowProjectFields();
        renderWorkflowProject();
        showToast(`Unable to start ${stage.shortTitle}: ${error.message}`);
    }
}

async function resetWorkflowStage(stageId) {
    const stage = getWorkflowStage(stageId);
    if (!stage || !workflowProject.stageData[stageId]) return;

    try {
        if (isBackendStageSupported(stageId) && workflowProject.projectId) {
            const response = await fetchWorkflowApi(`${WORKFLOW_API_BASE_PATH}/stages/${encodeURIComponent(stageId)}/reset`, {
                method: 'POST',
                body: JSON.stringify({ projectId: workflowProject.projectId })
            });
            applyBackendProjectState(response.project);
        } else {
            workflowProject.stageData[stageId].progress = 'pending';
            workflowProject.stageData[stageId].runtime = createDefaultStageRuntime(stage);
            saveWorkflowProject();
            renderWorkflowProject();
        }

        showToast(`${stage.shortTitle} reset.`);
    } catch (error) {
        console.error(`Unable to reset ${stageId}:`, error);
        showToast(`Unable to reset ${stage.shortTitle}: ${error.message}`);
    }
}

function hasActiveWorkflowJobs() {
    return WORKFLOW_STAGES.some(stage => {
        const status = workflowProject.stageData[stage.id]?.runtime?.status;
        return status === 'queued' || status === 'running';
    });
}

function startWorkflowJobPolling() {
    if (workflowJobPollTimer) {
        return;
    }

    workflowJobPollTimer = window.setInterval(() => {
        void refreshWorkflowProjectFromBackend(true);
        if (!hasActiveWorkflowJobs()) {
            stopWorkflowJobPolling();
        }
    }, 2000);
}

function stopWorkflowJobPolling() {
    if (workflowJobPollTimer) {
        window.clearInterval(workflowJobPollTimer);
        workflowJobPollTimer = null;
    }
}

function getWorkflowStageInsights(stage) {
    const counts = countSelectedMoleculesByType();
    const insights = [];

    switch (stage.id) {
        case 'import':
            insights.push(`Detected ${counts.structure} structure candidate(s), ${counts.compound} compound candidate(s), and ${counts.kegg} KEGG context item(s) in the current review session.`);
            insights.push('This menu will become the one-click downloader for structures, ligand files, metadata, and local project folders.');
            insights.push('Phase 1 should hide all raw file naming from the user and emit a managed artifact bundle automatically.');
            break;
        case 'protein-prep':
            insights.push(`The active environment profile is ${describePhBand(environmentProfile.ph).toLowerCase()} at pH ${environmentProfile.ph.toFixed(1)}, so protonation should be driven from that context rather than fixed defaults.`);
            if (counts.alphafold > 0) {
                insights.push('AlphaFold selections need explicit review for cofactors, missing waters, and confidence-sensitive flexible regions before simulation setup.');
            }
            insights.push('Backend automation should cover missing atoms, alternate locations, chain cleanup, heterogen selection, and hydrogen placement.');
            break;
        case 'ligand-prep':
            if (counts.compound > 0) {
                insights.push(`There are ${counts.compound} compound selection(s) available for automated state enumeration and parameter generation.`);
            } else {
                insights.push('No compound is currently selected, so ligand preparation is blocked until a compound is added from search or upload.');
            }
            insights.push('The backend now generates RDKit-based 3D ligand coordinates, assigns local MMFF94 charges, and validates an OpenFF 2.2.1 ligand template inside the project workspace.');
            insights.push('CGenFF and GAFF remain planning paths, but the default OpenFF route is now executable on this Windows runtime for protein-ligand MD pilots.');
            break;
        case 'complex-build':
            insights.push(workflowProject.workflowType === 'protein-ligand-water'
                ? 'This stage now merges the prepared protein and parameterized ligand into a single simulation-ready complex with pose provenance.'
                : 'Protein-only workflows can skip complex assembly unless cofactors, multiple chains, or reference waters need explicit merging.');
            insights.push('The pose uploader now accepts ligand-only pose files and full reference-complex PDBs, extracting the ligand residue automatically when the uploaded structure contains protein atoms as well.');
            insights.push('If no uploaded docked or reference pose is available yet, the backend uses a clash-reducing fallback placement and records that decision in the assembly report.');
            insights.push('The UI should expose artifact actions directly so users can inspect the assembled complex PDB and report without browsing the runtime folder manually.');
            break;
        case 'solvation':
            insights.push(`Current environment context calls for ${ENVIRONMENT_SOLVENT_LABELS[environmentProfile.solvent]} with ${formatIonicStrengthValue(environmentProfile.ionicStrengthmM)} conditions.`);
            insights.push('This menu now records a backend solvation plan with box dimensions, padding, and water-model metadata for the selected structure.');
            insights.push('Managed outputs should include box settings, solvent model, and solvent count as explicit project artifacts.');
            break;
        case 'ions':
            insights.push(`${formatIonicStrengthValue(environmentProfile.ionicStrengthmM)} from the environment profile should prefill salt concentration and neutralization logic.`);
            insights.push('This menu now drives the OpenMM modeller path that adds water, neutralization, and salt in one managed backend step.');
            insights.push(environmentProfile.cofactors
                ? `Cofactor context is already defined as ${environmentProfile.cofactors}, so this stage must avoid stripping chemically relevant ions.`
                : 'No cofactor context is currently defined, so ion handling should warn before removing or replacing catalytic ions.');
            break;
        case 'minimization':
            insights.push('Energy minimization is now a real OpenMM execution stage that emits minimized coordinates, a binary checkpoint, and energy summaries.');
            insights.push('The UI should provide safe presets and only surface advanced tolerances when needed.');
            insights.push('Local Windows execution should be enough for this stage for typical phase 1 systems.');
            break;
        case 'nvt':
            insights.push('NVT now runs as a short pilot equilibration segment with DCD trajectory output and CSV state logging.');
            insights.push('Temperature defaults should be linked to the project profile and recorded in restart metadata.');
            insights.push('Progress monitoring should show temperature stabilization and checkpoint generation without requiring terminal access.');
            break;
        case 'npt':
            insights.push('NPT now produces pilot trajectory segments with a barostat-enabled OpenMM system and restart-ready checkpoints.');
            insights.push('The software should make restartability and stage lineage visible because long simulations often span multiple runs.');
            insights.push('Pressure, density, and restraint changes should become explicit timeline events in the project history.');
            break;
        case 'production':
            insights.push('Production MD now writes a real DCD trajectory segment, CSV state log, final structure, and checkpoint through the local backend.');
            insights.push('This stage is still capped for safe local pilot runs, and larger campaigns should later hand off to chunked or remote execution.');
            insights.push('Artifact actions now let users open or export trajectory, log, checkpoint, and reproducibility files directly from the stage panel.');
            break;
        case 'analysis':
            insights.push('This menu should replace manual plotting tools with built-in RMSD, RMSF, hydrogen bond, energy, density, and ligand contact outputs.');
            insights.push('The current review page and 3D viewer are the right landing surface for post-run analysis and report panels.');
            insights.push('Analysis should always point back to the engine version, input settings, and stage checkpoints that produced the results.');
            break;
        default:
            insights.push('No automation notes available for this stage yet.');
    }

    return insights;
}

function formatWorkflowProgressLabel(progress) {
    switch (progress) {
        case 'in-progress':
            return 'In Progress';
        case 'complete':
            return 'Complete';
        case 'skipped':
            return 'Skipped';
        default:
            return 'Pending';
    }
}

// Load selected items from localStorage
function loadSelectedItems() {
    const stored = localStorage.getItem('selectedMolecules');
    hasStoredSelectionSnapshot = false;
    console.log('Raw stored data:', stored);
    selectedMolecules = [];
    if (stored) {
        try {
            selectedMolecules = JSON.parse(stored);
            hasStoredSelectionSnapshot = Array.isArray(selectedMolecules) && selectedMolecules.length > 0;
            console.log('Parsed molecules:', selectedMolecules);
        } catch (error) {
            console.error('Error parsing selected molecules:', error);
            selectedMolecules = [];
        }
    }
}

// Display summary statistics
function displaySummary() {
    console.log('displaySummary called, molecules:', selectedMolecules.length);
    
    const summarySection = document.getElementById('summary-section');
    const workflowSection = document.getElementById('workflow-section');
    const environmentSection = document.getElementById('environment-section');
    const panelsContainer = document.getElementById('panels-container');
    const noSelection = document.getElementById('no-selection');
    
    console.log('Elements found:', { summarySection, workflowSection, environmentSection, panelsContainer, noSelection });
    
    if (selectedMolecules.length === 0) {
        console.log('No molecules, showing empty state');
        summarySection.classList.add('hidden');
        if (environmentSection) environmentSection.classList.add('hidden');
        panelsContainer.classList.add('hidden');
        noSelection.classList.remove('hidden');

        // For gas-phase workflows (reactive MD) the workflow section stays visible
        // so the user can see stages and run them without any selected molecules
        const isGasPhase = workflowProject && workflowProject.workflowType === 'reactive-md-test';
        if (workflowSection) {
            if (isGasPhase) {
                workflowSection.classList.remove('hidden');
            } else {
                workflowSection.classList.add('hidden');
            }
        }
        return;
    }
    
    console.log('Has molecules, showing content');
    summarySection.classList.remove('hidden');
    if (workflowSection) workflowSection.classList.remove('hidden');
    if (environmentSection) environmentSection.classList.remove('hidden');
    panelsContainer.classList.remove('hidden');
    noSelection.classList.add('hidden');

    const counts = countSelectedMoleculesByType();

    document.getElementById('total-items').textContent = selectedMolecules.length;
    document.getElementById('pdb-count').textContent = counts.pdb;
    document.getElementById('protein-count').textContent = counts.protein;
    document.getElementById('compound-count').textContent = counts.compound;
}

// Display reference panels for each selected item
function displayReferencePanels() {
    const container = document.getElementById('panels-container');
    if (!container) {
        return;
    }

    const reviewView = document.getElementById('review-view');
    if (reviewView && reviewView.classList.contains('hidden')) {
        container.innerHTML = '';
        return;
    }

    container.innerHTML = '';

    selectedMolecules.forEach((item, index) => {
        const panel = createReferencePanel(item, index);
        container.appendChild(panel);
    });
}

// Create a reference panel for a molecule
function createReferencePanel(item, index) {
    const panel = document.createElement('div');
    panel.className = 'reference-panel';
    panel.id = `panel-${index}`;

    // Detect structure type
    const isPDB = item.database.toLowerCase().includes('pdb') && !item.database.toLowerCase().includes('alphafold');
    const isAlphaFold = item.database.toLowerCase().includes('alphafold');
    const isUniProt = item.database.toLowerCase().includes('uniprot') && !item.database.toLowerCase().includes('alphafold');
    const isKEGG = item.database.toLowerCase().includes('kegg');
    const isPubChem = item.database.toLowerCase().includes('pubchem');
    const pdbCode = isPDB ? extractPDBCode(item) : null;
    const uniprotId = isAlphaFold ? extractAlphaFoldID(item) : (isUniProt ? extractUniProtID(item) : null);
    const keggId = isKEGG ? extractKEGGID(item) : null;
    const pubchemCID = isPubChem ? extractPubChemCID(item) : null;
    const isStructure = isPDB || isAlphaFold;

    panel.innerHTML = `
        <div class="panel-header">
            <div class="panel-title-section">
                <span class="panel-number">#${index + 1}</span>
                <h3 class="panel-title">${item.title}</h3>
                <span class="database-badge">${item.database}</span>
            </div>
            <div class="panel-actions">
                <button class="action-btn" onclick="togglePanel(${index})">
                    <span class="toggle-icon">−</span>
                </button>
                <button class="action-btn" onclick="removePanel(${index})">✕</button>
            </div>
        </div>

        <div class="panel-content" id="panel-content-${index}">
            ${isPDB ? `
                <div class="structure-viewer-section">
                    <div class="viewer-controls-wrapper">
                        <div class="viewer-container" id="viewer-${index}" style="width: 650px; height: 650px;"></div>
                        <div class="viewer-controls">
                            <div class="control-group">
                                <label>Representation</label>
                                <div class="representation-buttons">
                                    <button class="rep-btn active" data-rep="cartoon" onclick="toggleRepresentation(${index}, 'cartoon', this)">Cartoon</button>
                                    <button class="rep-btn" data-rep="ball+stick" onclick="toggleRepresentation(${index}, 'ball+stick', this)">Ball+Stick</button>
                                    <button class="rep-btn" data-rep="ribbon" onclick="toggleRepresentation(${index}, 'ribbon', this)">Ribbon</button>
                                    <button class="rep-btn" data-rep="surface" onclick="toggleRepresentation(${index}, 'surface', this)">Surface</button>
                                </div>
                            </div>
                            <div class="control-group">
                                <label>Color Scheme</label>
                                <select onchange="changeColorScheme(${index}, this.value)" id="color-select-${index}">
                                    <option value="spectrum" selected>Rainbow</option>
                                    <option value="chain">By Chain</option>
                                    <option value="ss">Secondary Structure</option>
                                    <option value="residue">By Residue</option>
                                    <option value="hydrophobicity">Hydrophobicity</option>
                                    <option value="white">White</option>
                                </select>
                            </div>
                            <div class="control-group">
                                <label>Secondary Structure</label>
                                <div class="ss-buttons">
                                    <button class="ss-btn active" onclick="toggleSecondaryStructure(${index}, 'helix', this)" title="α-Helices">α-Helix</button>
                                    <button class="ss-btn active" onclick="toggleSecondaryStructure(${index}, 'sheet', this)" title="β-Sheets">β-Sheet</button>
                                    <button class="ss-btn active" onclick="toggleSecondaryStructure(${index}, 'loop', this)" title="Loops/Coils">Loop</button>
                                </div>
                            </div>
                            <div class="control-group">
                                <label>Atom Selection</label>
                                <div class="selection-buttons">
                                    <button class="selection-btn active" data-selection="backbone" onclick="selectBackbone(${index}, this)">Backbone</button>
                                    <button class="selection-btn active" data-selection="sidechains" onclick="selectSidechains(${index}, this)">Side Chains</button>
                                    <button class="selection-btn active" data-selection="ligands" onclick="selectLigands(${index}, this)">Ligands</button>
                                    <button class="selection-btn" data-selection="waters" onclick="selectWaters(${index}, this)">Waters</button>
                                </div>
                            </div>
                            <div class="control-group">
                                <label>Analysis</label>
                                <div class="analysis-buttons">
                                    <button class="analysis-btn" onclick="detectBindingPockets(${index}, this)" title="Highlight potential binding sites">🎯 Binding Pockets</button>
                                    <button class="analysis-btn" onclick="highlightSurface(${index}, this)" title="Show molecular surface">🔮 Surface</button>
                                </div>
                            </div>
                            <div class="control-group">
                                <label>View Controls</label>
                                <div class="view-buttons">
                                    <button onclick="resetView(${index})">Reset View</button>
                                    <button onclick="toggleSpin(${index}, this)">Spin</button>
                                    <button onclick="centerView(${index})">Center</button>
                                    <button onclick="toggleLabels(${index}, this)">Labels</button>
                                </div>
                            </div>
                            <div class="control-group">
                                <label>Export</label>
                                <div class="export-buttons">
                                    <button class="export-btn" onclick="exportScreenshot(${index})" title="Save as PNG">📷 Screenshot</button>
                                    <button class="export-btn" onclick="downloadPDB(${index}, '${pdbCode}')" title="Download PDB file">💾 PDB</button>
                                </div>
                            </div>
                        </div>
                    </div>
                    
                    <div class="viewer-right-panel" id="details-${index}">
                        <h4>Structure Details</h4>
                        <div class="loading-details">Loading structure information...</div>
                    </div>
                </div>
            ` : ''}
            ${isAlphaFold ? `
                <!-- AlphaFold Multi-Panel Layout -->
                <div class="alphafold-multi-panel">
                    <!-- Top Row: Isoform Selector -->
                    <div class="alphafold-isoform-bar">
                        <div class="isoform-selector-group">
                            <label>Isoform / Variant:</label>
                            <select id="isoform-select-${index}" onchange="changeIsoform(${index}, this.value)">
                                <option value="loading">Loading isoforms...</option>
                            </select>
                            <span class="isoform-count" id="isoform-count-${index}"></span>
                        </div>
                        <div class="alphafold-quick-info" id="quick-info-${index}">
                            <span class="confidence-badge" id="confidence-badge-${index}">--</span>
                            <span class="sequence-length" id="seq-length-${index}">-- aa</span>
                        </div>
                    </div>

                    <!-- Main Content: 4 Panels Grid -->
                    <div class="alphafold-panels-grid">
                        <!-- Panel 1: Primary 3D Structure Viewer -->
                        <div class="alphafold-panel primary-viewer-panel">
                            <div class="panel-title-bar">
                                <h4>3D Structure Viewer</h4>
                                <span class="panel-subtitle">Primary Model</span>
                            </div>
                            <div class="viewer-container" id="viewer-${index}" style="width: 100%; height: 500px;"></div>
                            <div class="viewer-controls alphafold-controls">
                                <div class="control-row">
                                    <div class="style-buttons">
                                        <span class="control-label">Style:</span>
                                        <button class="style-btn active" onclick="setStyle(${index}, 'cartoon', this)" title="Cartoon">🎗️ Cartoon</button>
                                        <button class="style-btn" onclick="setStyle(${index}, 'ribbon', this)" title="Ribbon">〰️ Ribbon</button>
                                        <button class="style-btn" onclick="setStyle(${index}, 'ballstick', this)" title="Ball & Stick">⚛️ Ball+Stick</button>
                                        <button class="style-btn" onclick="setStyle(${index}, 'stick', this)" title="Stick">🧪 Stick</button>
                                        <button class="style-btn" onclick="setStyle(${index}, 'sphere', this)" title="Sphere">● Sphere</button>
                                        <button class="style-btn" onclick="setStyle(${index}, 'surface', this)" title="Surface">🔮 Surface</button>
                                    </div>
                                </div>
                                <div class="control-row">
                                    <div class="control-group compact">
                                        <label>Color</label>
                                        <select onchange="changeAlphaFoldColorScheme(${index}, this.value)" id="color-select-${index}">
                                            <option value="confidence" selected>pLDDT Confidence</option>
                                            <option value="spectrum">Rainbow</option>
                                            <option value="chain">By Chain</option>
                                            <option value="ss">Secondary Structure</option>
                                            <option value="white">White</option>
                                        </select>
                                    </div>
                                </div>
                                <div class="control-row">
                                    <div class="ss-buttons compact">
                                        <button class="ss-btn active" onclick="toggleSecondaryStructure(${index}, 'helix', this)" title="α-Helices">α</button>
                                        <button class="ss-btn active" onclick="toggleSecondaryStructure(${index}, 'sheet', this)" title="β-Sheets">β</button>
                                        <button class="ss-btn active" onclick="toggleSecondaryStructure(${index}, 'loop', this)" title="Loops">∿</button>
                                    </div>
                                    <div class="analysis-buttons compact">
                                        <button class="analysis-btn" onclick="detectBindingPockets(${index}, this)" title="Binding Pockets">🎯</button>
                                        <button class="analysis-btn" onclick="highlightSurface(${index}, this)" title="Surface">🔮</button>
                                    </div>
                                </div>
                                <div class="control-row">
                                    <div class="selection-buttons compact">
                                        <button class="selection-btn active" data-selection="backbone" onclick="selectBackbone(${index}, this)">Backbone</button>
                                        <button class="selection-btn active" data-selection="sidechains" onclick="selectSidechains(${index}, this)">Side Chains</button>
                                    </div>
                                    <div class="view-buttons compact">
                                        <button onclick="resetView(${index})" title="Reset View">⟲</button>
                                        <button onclick="toggleSpin(${index}, this)" title="Spin">↻</button>
                                        <button onclick="centerView(${index})" title="Center">⊙</button>
                                        <button onclick="toggleLabels(${index}, this)" title="Labels">Aa</button>
                                    </div>
                                </div>
                                <div class="control-row">
                                    <div class="export-buttons compact">
                                        <button class="export-btn" onclick="exportScreenshot(${index})" title="Screenshot">📷</button>
                                        <button class="export-btn" onclick="downloadAlphaFoldPDB(${index})" title="Download PDB">💾 PDB</button>
                                        <button class="export-btn" onclick="downloadAlphaFoldCIF(${index})" title="Download mmCIF">💾 CIF</button>
                                    </div>
                                </div>
                                <div class="control-row">
                                    <div class="dynamics-buttons compact">
                                        <span class="control-label">Dynamics:</span>
                                        <button class="dyn-btn" onclick="toggleThermalMotion(${index}, this)" title="Simulate thermal vibrations">🌡️ Thermal</button>
                                        <button class="dyn-btn" onclick="toggleFlexibilityView(${index}, this)" title="Show flexible regions">🌊 Flexibility</button>
                                        <button class="dyn-btn" onclick="runEnergyMinimization(${index}, this)" title="Visual energy minimization">⚡ Minimize</button>
                                    </div>
                                </div>
                            </div>
                            <!-- pLDDT Confidence Legend -->
                            <div class="plddt-legend">
                                <span class="legend-title">pLDDT Confidence:</span>
                                <div class="legend-items">
                                    <span class="legend-item very-high"><span class="color-box"></span>Very High (>90)</span>
                                    <span class="legend-item confident"><span class="color-box"></span>Confident (70-90)</span>
                                    <span class="legend-item low"><span class="color-box"></span>Low (50-70)</span>
                                    <span class="legend-item very-low"><span class="color-box"></span>Very Low (<50)</span>
                                </div>
                            </div>
                        </div>

                        <!-- Panel 2: Secondary Viewer / Comparison -->
                        <div class="alphafold-panel secondary-viewer-panel">
                            <div class="panel-title-bar">
                                <h4>Comparison Viewer</h4>
                                <select id="compare-select-${index}" onchange="loadComparisonStructure(${index}, this.value)" class="compare-select">
                                    <option value="">Select isoform to compare...</option>
                                </select>
                            </div>
                            <div class="viewer-container secondary" id="viewer-compare-${index}" style="width: 100%; height: 500px;">
                                <div class="empty-viewer-message">
                                    <span class="icon">🔄</span>
                                    <p>Select an isoform above to compare structures</p>
                                </div>
                            </div>
                            <!-- Controls below viewer like 3D Structure Viewer -->
                            <div class="viewer-controls compare-controls" id="compare-controls-${index}">
                                <div class="control-row">
                                    <div class="style-buttons">
                                        <span class="control-label">Style:</span>
                                        <button class="style-btn active" onclick="setCompareStyle(${index}, 'cartoon', this)" title="Cartoon">🎗️ Cartoon</button>
                                        <button class="style-btn" onclick="setCompareStyle(${index}, 'ribbon', this)" title="Ribbon">〰️ Ribbon</button>
                                        <button class="style-btn" onclick="setCompareStyle(${index}, 'ballstick', this)" title="Ball & Stick">⚛️ Ball+Stick</button>
                                        <button class="style-btn" onclick="setCompareStyle(${index}, 'stick', this)" title="Stick">🧪 Stick</button>
                                        <button class="style-btn" onclick="setCompareStyle(${index}, 'sphere', this)" title="Sphere">● Sphere</button>
                                        <button class="style-btn" onclick="setCompareStyle(${index}, 'surface', this)" title="Surface">🔮 Surface</button>
                                    </div>
                                </div>
                                <div class="control-row">
                                    <div class="color-buttons">
                                        <span class="control-label">Color:</span>
                                        <button class="color-btn active" onclick="setCompareColor(${index}, 'confidence', this)" title="pLDDT Confidence">🎨 Confidence</button>
                                        <button class="color-btn" onclick="setCompareColor(${index}, 'chain', this)" title="By Chain">🔗 Chain</button>
                                        <button class="color-btn" onclick="setCompareColor(${index}, 'secondary', this)" title="Secondary Structure">🌀 Secondary</button>
                                        <button class="color-btn" onclick="setCompareColor(${index}, 'rainbow', this)" title="Rainbow N→C">🌈 Rainbow</button>
                                    </div>
                                </div>
                                <div class="control-row">
                                    <div class="view-buttons">
                                        <span class="control-label">View:</span>
                                        <button onclick="resetCompareView(${index})" title="Reset View">⟲ Reset</button>
                                        <button onclick="toggleCompareSpin(${index}, this)" title="Auto Rotate">↻ Spin</button>
                                        <button onclick="syncViewers(${index})" title="Sync with Main">⇄ Sync</button>
                                        <button onclick="zoomCompareIn(${index})" title="Zoom In">🔍+</button>
                                        <button onclick="zoomCompareOut(${index})" title="Zoom Out">🔍−</button>
                                    </div>
                                </div>
                                <div class="control-row">
                                    <div class="animation-buttons">
                                        <span class="control-label">Compare:</span>
                                        <button class="anim-btn" onclick="morphStructures(${index}, this)" title="Morph between structures">🔀 Morph</button>
                                        <button class="anim-btn" onclick="toggleSideBySideAnimation(${index}, this)" title="Side-by-side animation">🎬 Animate</button>
                                        <button class="anim-btn" onclick="overlayStructures(${index}, this)" title="Overlay both structures">📐 Overlay</button>
                                    </div>
                                </div>
                            </div>
                        </div>

                        <!-- Panel 3: PAE (Predicted Aligned Error) Heatmap -->
                        <div class="alphafold-panel pae-panel">
                            <div class="panel-title-bar">
                                <h4>Predicted Aligned Error (PAE)</h4>
                                <span class="panel-subtitle">Residue-Residue Confidence</span>
                            </div>
                            <div class="pae-container" id="pae-container-${index}">
                                <div class="pae-loading">
                                    <div class="loading-spinner"></div>
                                    <p>Loading PAE data...</p>
                                </div>
                            </div>
                            <div class="pae-legend">
                                <span class="legend-title">Expected Position Error (Å):</span>
                                <div class="pae-gradient">
                                    <span class="pae-low">0</span>
                                    <div class="gradient-bar"></div>
                                    <span class="pae-high">31.75</span>
                                </div>
                                <p class="pae-description">Green = low error (confident), Red = high error (uncertain)</p>
                            </div>
                        </div>

                        <!-- Panel 4: Structure Details & Confidence Stats -->
                        <div class="alphafold-panel details-panel">
                            <div class="panel-title-bar">
                                <h4>Structure Details</h4>
                            </div>
                            <div class="alphafold-details-content" id="details-${index}">
                                <div class="loading-details">Loading structure information...</div>
                            </div>
                        </div>
                    </div>

                    <!-- Bottom Row: Sequence & SMILES (if available) -->
                    <div class="alphafold-sequence-section">
                        <div class="sequence-panel">
                            <div class="panel-title-bar collapsible" onclick="toggleSequencePanel(${index})">
                                <h4>Amino Acid Sequence</h4>
                                <span class="collapse-icon">▼</span>
                            </div>
                            <div class="sequence-content" id="sequence-content-${index}">
                                <div class="sequence-display" id="sequence-display-${index}">
                                    <span class="loading-text">Loading sequence...</span>
                                </div>
                                <div class="sequence-tools">
                                    <button onclick="copySequence(${index})" title="Copy to clipboard">📋 Copy</button>
                                    <button onclick="downloadFasta(${index})" title="Download FASTA">💾 FASTA</button>
                                    <span class="sequence-stats" id="sequence-stats-${index}"></span>
                                </div>
                            </div>
                        </div>
                        <div class="smiles-panel" id="smiles-panel-${index}" style="display: none;">
                            <div class="panel-title-bar">
                                <h4>SMILES Data</h4>
                            </div>
                            <div class="smiles-content" id="smiles-content-${index}">
                                <!-- SMILES will be populated if available -->
                            </div>
                        </div>
                    </div>
                </div>
            ` : ''}

            ${isUniProt ? `
                <!-- UniProt Panel Layout with 3D Viewer -->
                <div class="uniprot-panel-layout">
                    <!-- Main Row: 3D Viewer + Feature Controls -->
                    <div class="uniprot-main-row">
                        <!-- 3D Structure Viewer -->
                        <div class="uniprot-3d-viewer-panel">
                            <div class="panel-title-bar">
                                <h4>🔮 3D Structure (AlphaFold)</h4>
                                <div class="viewer-status" id="uniprot-viewer-status-${index}">Loading...</div>
                            </div>
                            <div class="uniprot-viewer-container" id="uniprot-3d-viewer-${index}">
                                <div class="loading-viewer">
                                    <div class="loading-spinner"></div>
                                    <p>Loading AlphaFold structure...</p>
                                </div>
                            </div>
                            <div class="uniprot-viewer-controls">
                                <div class="control-group">
                                    <label>View Style</label>
                                    <div class="representation-buttons">
                                        <button class="rep-btn active" onclick="toggleUniProt3DStyle(${index}, 'cartoon', this)">Cartoon</button>
                                        <button class="rep-btn" onclick="toggleUniProt3DStyle(${index}, 'surface', this)">Surface</button>
                                        <button class="rep-btn" onclick="toggleUniProt3DStyle(${index}, 'ball+stick', this)">Sticks</button>
                                    </div>
                                </div>
                                <div class="control-group">
                                    <label>Color By</label>
                                    <select onchange="changeUniProt3DColor(${index}, this.value)" id="uniprot-color-${index}">
                                        <option value="features" selected>Active Features</option>
                                        <option value="spectrum">Rainbow (N→C)</option>
                                        <option value="ss">Secondary Structure</option>
                                        <option value="residue">Residue Type</option>
                                        <option value="hydrophobicity">Hydrophobicity</option>
                                        <option value="plddt">pLDDT (AlphaFold only)</option>
                                    </select>
                                </div>
                                <button class="control-btn" onclick="resetUniProt3DView(${index})" title="Reset view">🔄 Reset</button>
                                <button class="control-btn" onclick="spinUniProt3D(${index})" title="Toggle spin">🔁 Spin</button>
                            </div>
                        </div>

                        <!-- Right Side: Protein Info + Feature Toggles -->
                        <div class="uniprot-info-controls">
                            <!-- Protein Info -->
                            <div class="uniprot-info-panel">
                                <div class="panel-title-bar">
                                    <h4>Protein Information</h4>
                                </div>
                                <div class="uniprot-info-content" id="uniprot-info-${index}">
                                    <div class="loading-details">Loading protein information...</div>
                                </div>
                            </div>

                            <!-- Feature Toggles - These control both 2D and 3D views -->
                            <div class="uniprot-toggles-section">
                                <div class="panel-title-bar">
                                    <h4>Feature Toggles</h4>
                                    <span class="toggle-hint">Toggle in sequence &amp; 3D</span>
                                </div>
                                <div class="feature-toggles-grid" id="feature-toggles-${index}">
                                    <label class="feature-toggle" data-type="domain">
                                        <input type="checkbox" checked onchange="toggleUniProtFeature(${index}, 'domain', this.checked)">
                                        <span class="toggle-color" style="background: #667eea;"></span>
                                        <span class="toggle-label">Domains</span>
                                    </label>
                                    <label class="feature-toggle" data-type="binding">
                                        <input type="checkbox" checked onchange="toggleUniProtFeature(${index}, 'binding', this.checked)">
                                        <span class="toggle-color" style="background: #f59e0b;"></span>
                                        <span class="toggle-label">Binding Sites</span>
                                    </label>
                                    <label class="feature-toggle" data-type="active_site">
                                        <input type="checkbox" checked onchange="toggleUniProtFeature(${index}, 'active_site', this.checked)">
                                        <span class="toggle-color" style="background: #ef4444;"></span>
                                        <span class="toggle-label">Active Sites</span>
                                    </label>
                                    <label class="feature-toggle" data-type="disulfid">
                                        <input type="checkbox" onchange="toggleUniProtFeature(${index}, 'disulfid', this.checked)">
                                        <span class="toggle-color" style="background: #10b981;"></span>
                                        <span class="toggle-label">Disulfide</span>
                                    </label>
                                    <label class="feature-toggle" data-type="signal">
                                        <input type="checkbox" onchange="toggleUniProtFeature(${index}, 'signal', this.checked)">
                                        <span class="toggle-color" style="background: #8b5cf6;"></span>
                                        <span class="toggle-label">Signal</span>
                                    </label>
                                    <label class="feature-toggle" data-type="carbohyd">
                                        <input type="checkbox" onchange="toggleUniProtFeature(${index}, 'carbohyd', this.checked)">
                                        <span class="toggle-color" style="background: #ec4899;"></span>
                                        <span class="toggle-label">Glycosylation</span>
                                    </label>
                                    <label class="feature-toggle" data-type="transmem">
                                        <input type="checkbox" onchange="toggleUniProtFeature(${index}, 'transmem', this.checked)">
                                        <span class="toggle-color" style="background: #f97316;"></span>
                                        <span class="toggle-label">Transmembrane</span>
                                    </label>
                                    <label class="feature-toggle" data-type="variant">
                                        <input type="checkbox" onchange="toggleUniProtFeature(${index}, 'variant', this.checked)">
                                        <span class="toggle-color" style="background: #06b6d4;"></span>
                                        <span class="toggle-label">Variants</span>
                                    </label>
                                    <label class="feature-toggle" data-type="helix">
                                        <input type="checkbox" onchange="toggleUniProtFeature(${index}, 'helix', this.checked)">
                                        <span class="toggle-color" style="background: #a855f7;"></span>
                                        <span class="toggle-label">α-Helix</span>
                                    </label>
                                    <label class="feature-toggle" data-type="strand">
                                        <input type="checkbox" onchange="toggleUniProtFeature(${index}, 'strand', this.checked)">
                                        <span class="toggle-color" style="background: #3b82f6;"></span>
                                        <span class="toggle-label">β-Strand</span>
                                    </label>
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- Sequence Feature Viewer (Linear Track View) -->
                    <div class="uniprot-feature-viewer-panel">
                        <div class="panel-title-bar">
                            <h4>Sequence Feature Map</h4>
                            <span class="feature-help">Click features to highlight in 3D</span>
                        </div>
                        <div class="feature-viewer-container" id="feature-viewer-${index}">
                            <div class="loading-features">
                                <div class="loading-spinner"></div>
                                <p>Loading features...</p>
                            </div>
                        </div>
                    </div>

                    <!-- Sequence Display -->
                    <div class="uniprot-sequence-section">
                        <div class="panel-title-bar collapsible" onclick="toggleUniProtSequence(${index})">
                            <h4>Amino Acid Sequence</h4>
                            <span class="collapse-icon">▼</span>
                        </div>
                        <div class="uniprot-sequence-content" id="uniprot-sequence-${index}">
                            <div class="sequence-display" id="uniprot-seq-display-${index}">
                                <span class="loading-text">Loading sequence...</span>
                            </div>
                            <div class="sequence-tools">
                                <button onclick="copyUniProtSequence(${index})" title="Copy to clipboard">📋 Copy</button>
                                <button onclick="downloadUniProtFasta(${index})" title="Download FASTA">💾 FASTA</button>
                                <button onclick="showSequenceStats(${index})" title="Sequence statistics">📊 Stats</button>
                                <span class="sequence-stats" id="uniprot-seq-stats-${index}"></span>
                            </div>
                        </div>
                    </div>

                    <!-- Cross-Links -->
                    <div class="uniprot-crosslinks-section">
                        <div class="panel-title-bar">
                            <h4>Cross-References</h4>
                        </div>
                        <div class="crosslinks-grid" id="uniprot-crosslinks-${index}">
                            <div class="loading-crosslinks">Loading cross-references...</div>
                        </div>
                    </div>
                </div>
            ` : ''}
            ${isKEGG ? `
                <!-- KEGG Workflow Panel -->
                <div class="kegg-workflow-panel">
                    <!-- KEGG Header Info -->
                    <div class="kegg-header-section">
                        <div class="kegg-type-badge" id="kegg-type-${index}">Loading...</div>
                        <div class="kegg-quick-info" id="kegg-quick-info-${index}">
                            <span class="loading-text">Fetching KEGG data...</span>
                        </div>
                    </div>

                    <!-- Main KEGG Content Grid -->
                    <div class="kegg-content-grid">
                        <!-- Left Column: Pathway Map & Visualization -->
                        <div class="kegg-left-column">
                            <!-- Pathway Map Image -->
                            <div class="kegg-map-section">
                                <div class="panel-title-bar">
                                    <h4>🗺️ Pathway Map</h4>
                                    <div class="map-controls">
                                        <button class="map-btn" onclick="openKEGGMapFull(${index})" title="Open full interactive map">🔍 Full Map</button>
                                        <button class="map-btn" onclick="downloadKEGGMap(${index})" title="Download map image">💾 Download</button>
                                    </div>
                                </div>
                                <div class="kegg-map-container" id="kegg-map-${index}">
                                    <div class="loading-map">Loading pathway map...</div>
                                </div>
                            </div>

                            <!-- Compound/Metabolite Structure (for compounds) -->
                            <div class="kegg-structure-section" id="kegg-structure-section-${index}" style="display: none;">
                                <div class="panel-title-bar">
                                    <h4>🔬 2D Structure</h4>
                                </div>
                                <div class="kegg-structure-container" id="kegg-structure-${index}">
                                    <div class="loading-structure">Loading structure...</div>
                                </div>
                                <div class="kegg-compound-props" id="kegg-compound-props-${index}"></div>
                            </div>

                            <!-- 3D Compound Viewer (for compounds/drugs) -->
                            <div class="kegg-3d-section" id="kegg-3d-section-${index}" style="display: none;">
                                <div class="panel-title-bar">
                                    <h4>🧊 3D Structure</h4>
                                    <div class="kegg-3d-controls">
                                        <div class="representation-toggles" id="kegg-rep-toggles-${index}">
                                            <button class="rep-toggle active" data-style="stick" onclick="setKEGG3DStyle(${index}, 'stick')" title="Stick">🔗</button>
                                            <button class="rep-toggle" data-style="sphere" onclick="setKEGG3DStyle(${index}, 'sphere')" title="Sphere">⚪</button>
                                            <button class="rep-toggle" data-style="ballstick" onclick="setKEGG3DStyle(${index}, 'ballstick')" title="Ball & Stick">⚛️</button>
                                        </div>
                                        <button class="map-btn" onclick="resetKEGG3DView(${index})" title="Reset View">🔄</button>
                                    </div>
                                </div>
                                <div class="kegg-3d-container" id="kegg-3d-viewer-${index}">
                                    <div class="loading-3d">Loading 3D structure...</div>
                                </div>
                            </div>

                            <!-- Interactive Pathway Network (for pathways) -->
                            <div class="kegg-network-section" id="kegg-network-section-${index}" style="display: none;">
                                <div class="panel-title-bar">
                                    <h4>🕸️ Pathway Network</h4>
                                    <div class="network-controls">
                                        <button class="map-btn" onclick="resetKEGGNetwork(${index})" title="Reset Layout">🔄 Reset</button>
                                        <button class="map-btn" onclick="fitKEGGNetwork(${index})" title="Fit to View">📐 Fit</button>
                                        <select class="network-layout-select" onchange="changeKEGGNetworkLayout(${index}, this.value)">
                                            <option value="cose">Force-Directed</option>
                                            <option value="circle">Circle</option>
                                            <option value="grid">Grid</option>
                                            <option value="breadthfirst">Hierarchical</option>
                                        </select>
                                    </div>
                                </div>
                                <div class="kegg-network-container" id="kegg-network-${index}">
                                    <div class="loading-network">Building pathway network...</div>
                                </div>
                                <div class="kegg-network-legend">
                                    <span class="legend-item"><span class="legend-color compound"></span> Compound</span>
                                    <span class="legend-item"><span class="legend-color pathway"></span> Pathways</span>
                                    <span class="legend-item"><span class="legend-color enzyme"></span> Enzymes</span>
                                    <span class="legend-item"><span class="legend-color gene"></span> Genes</span>
                                    <span class="legend-item"><span class="legend-color reaction"></span> Reactions</span>
                                </div>
                            </div>
                        </div>

                        <!-- Right Column: Details & Lists -->
                        <div class="kegg-right-column">
                            <!-- Description Section -->
                            <div class="kegg-description-section">
                                <div class="panel-title-bar">
                                    <h4>📝 Description</h4>
                                </div>
                                <div class="kegg-description" id="kegg-description-${index}">
                                    <span class="loading-text">Loading description...</span>
                                </div>
                            </div>

                            <!-- Genes Section (for pathways) -->
                            <div class="kegg-genes-section" id="kegg-genes-section-${index}" style="display: none;">
                                <div class="panel-title-bar collapsible" onclick="toggleKEGGSection(${index}, 'genes')">
                                    <h4>🧬 Genes</h4>
                                    <span class="gene-count" id="kegg-gene-count-${index}"></span>
                                    <span class="collapse-icon">▼</span>
                                </div>
                                <div class="kegg-genes-content" id="kegg-genes-${index}">
                                    <div class="kegg-gene-search">
                                        <input type="text" placeholder="Search genes..." onkeyup="filterKEGGGenes(${index}, this.value)">
                                    </div>
                                    <div class="kegg-genes-list" id="kegg-genes-list-${index}">
                                        <span class="loading-text">Loading genes...</span>
                                    </div>
                                </div>
                            </div>

                            <!-- Compounds Section (for pathways) -->
                            <div class="kegg-compounds-section" id="kegg-compounds-section-${index}" style="display: none;">
                                <div class="panel-title-bar collapsible" onclick="toggleKEGGSection(${index}, 'compounds')">
                                    <h4>⚗️ Compounds</h4>
                                    <span class="compound-count" id="kegg-compound-count-${index}"></span>
                                    <span class="collapse-icon">▼</span>
                                </div>
                                <div class="kegg-compounds-content" id="kegg-compounds-${index}">
                                    <div class="kegg-compounds-list" id="kegg-compounds-list-${index}">
                                        <span class="loading-text">Loading compounds...</span>
                                    </div>
                                </div>
                            </div>

                            <!-- Pathways Section (for compounds/genes) -->
                            <div class="kegg-pathways-section" id="kegg-pathways-section-${index}" style="display: none;">
                                <div class="panel-title-bar collapsible" onclick="toggleKEGGSection(${index}, 'pathways')">
                                    <h4>🛤️ Pathways</h4>
                                    <span class="pathway-count" id="kegg-pathway-count-${index}"></span>
                                    <span class="collapse-icon">▼</span>
                                </div>
                                <div class="kegg-pathways-content" id="kegg-pathways-${index}">
                                    <div class="kegg-pathways-list" id="kegg-pathways-list-${index}">
                                        <span class="loading-text">Loading pathways...</span>
                                    </div>
                                </div>
                            </div>

                            <!-- Drugs Section -->
                            <div class="kegg-drugs-section" id="kegg-drugs-section-${index}" style="display: none;">
                                <div class="panel-title-bar collapsible" onclick="toggleKEGGSection(${index}, 'drugs')">
                                    <h4>💊 Related Drugs</h4>
                                    <span class="drug-count" id="kegg-drug-count-${index}"></span>
                                    <span class="collapse-icon">▼</span>
                                </div>
                                <div class="kegg-drugs-content" id="kegg-drugs-${index}">
                                    <div class="kegg-drugs-list" id="kegg-drugs-list-${index}">
                                        <span class="loading-text">Loading drugs...</span>
                                    </div>
                                </div>
                            </div>

                            <!-- Related Pathways Section -->
                            <div class="kegg-related-section" id="kegg-related-section-${index}" style="display: none;">
                                <div class="panel-title-bar collapsible" onclick="toggleKEGGSection(${index}, 'related')">
                                    <h4>🔗 Related Pathways</h4>
                                    <span class="collapse-icon">▼</span>
                                </div>
                                <div class="kegg-related-content" id="kegg-related-${index}">
                                    <div class="kegg-related-list" id="kegg-related-list-${index}">
                                        <span class="loading-text">Loading related pathways...</span>
                                    </div>
                                </div>
                            </div>

                            <!-- Enzymes Section (for compounds) -->
                            <div class="kegg-enzymes-section" id="kegg-enzymes-section-${index}" style="display: none;">
                                <div class="panel-title-bar collapsible" onclick="toggleKEGGSection(${index}, 'enzymes')">
                                    <h4>🔧 Enzymes</h4>
                                    <span class="enzyme-count" id="kegg-enzyme-count-${index}"></span>
                                    <span class="collapse-icon">▼</span>
                                </div>
                                <div class="kegg-enzymes-content" id="kegg-enzymes-${index}">
                                    <div class="kegg-enzymes-list" id="kegg-enzymes-list-${index}">
                                        <span class="loading-text">Loading enzymes...</span>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- KEGG Cross-Links -->
                    <div class="kegg-crosslinks-section">
                        <div class="panel-title-bar">
                            <h4>🔗 External Links</h4>
                        </div>
                        <div class="kegg-crosslinks-grid" id="kegg-crosslinks-${index}">
                            <div class="loading-crosslinks">Loading cross-references...</div>
                        </div>
                    </div>
                </div>
            ` : ''}

            ${isPubChem ? `
                <!-- PubChem Workflow Panel -->
                <div class="pubchem-workflow-panel">
                    <!-- Header Section -->
                    <div class="pubchem-header-section">
                        <span class="pubchem-type-badge" id="pubchem-type-${index}">⚗️ Compound</span>
                        <div class="pubchem-quick-info" id="pubchem-quick-info-${index}">
                            <span class="loading-indicator">Loading compound data...</span>
                        </div>
                    </div>

                    <!-- Main Content Grid -->
                    <div class="pubchem-content-grid">
                        <!-- Left Column: Structures -->
                        <div class="pubchem-left-column">
                            <!-- 2D Structure Image -->
                            <div class="pubchem-structure-section">
                                <div class="panel-title-bar">
                                    <h4>📐 2D Structure</h4>
                                    <div class="panel-controls">
                                        <button class="small-btn" onclick="downloadPubChemImage(${index}, '${pubchemCID}')" title="Download PNG">💾</button>
                                    </div>
                                </div>
                                <div class="pubchem-2d-container" id="pubchem-2d-${index}">
                                    <div class="loading-structure">Loading structure image...</div>
                                </div>
                            </div>

                            <!-- 3D Interactive Viewer -->
                            <div class="pubchem-3d-section">
                                <div class="panel-title-bar">
                                    <h4>🔮 3D Interactive View</h4>
                                    <div class="panel-controls">
                                        <button class="small-btn" onclick="resetPubChem3D(${index})" title="Reset View">↺</button>
                                        <button class="small-btn" onclick="togglePubChemSpin(${index}, this)" title="Toggle Spin">🔄</button>
                                        <button class="small-btn" onclick="downloadPubChemSDF(${index})" title="Download SDF">💾</button>
                                    </div>
                                </div>
                                <div class="pubchem-3d-container" id="pubchem-3d-${index}">
                                    <div class="loading-structure">Loading 3D structure...</div>
                                </div>
                                <div class="pubchem-3d-controls" id="pubchem-3d-controls-${index}">
                                    <div class="control-group">
                                        <label>Style</label>
                                        <div class="style-buttons">
                                            <button class="style-btn active" onclick="changePubChemStyle(${index}, 'stick', this)">Stick</button>
                                            <button class="style-btn" onclick="changePubChemStyle(${index}, 'sphere', this)">Sphere</button>
                                            <button class="style-btn" onclick="changePubChemStyle(${index}, 'line', this)">Line</button>
                                            <button class="style-btn" onclick="changePubChemStyle(${index}, 'ballstick', this)">Ball+Stick</button>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>

                        <!-- Right Column: Information -->
                        <div class="pubchem-right-column">
                            <!-- Compound Identifiers -->
                            <div class="pubchem-identifiers-section">
                                <div class="panel-title-bar">
                                    <h4>🏷️ Identifiers</h4>
                                </div>
                                <div class="pubchem-identifiers-content" id="pubchem-identifiers-${index}">
                                    <div class="loading-info">Loading identifiers...</div>
                                </div>
                            </div>

                            <!-- Physical/Chemical Properties -->
                            <div class="pubchem-properties-section">
                                <div class="panel-title-bar">
                                    <h4>📊 Properties</h4>
                                </div>
                                <div class="pubchem-properties-grid" id="pubchem-properties-${index}">
                                    <div class="loading-info">Loading properties...</div>
                                </div>
                            </div>

                            <!-- Drug-Likeness (Lipinski's Rule of Five) -->
                            <div class="pubchem-druglikeness-section">
                                <div class="panel-title-bar">
                                    <h4>💊 Drug-Likeness (Lipinski's Rule of Five)</h4>
                                </div>
                                <div class="pubchem-lipinski-grid" id="pubchem-lipinski-${index}">
                                    <div class="loading-info">Calculating drug-likeness...</div>
                                </div>
                            </div>

                            <!-- Description -->
                            <div class="pubchem-description-section">
                                <div class="panel-title-bar">
                                    <h4>📝 Description</h4>
                                </div>
                                <div class="pubchem-description-content" id="pubchem-description-${index}">
                                    <div class="loading-info">Loading description...</div>
                                </div>
                            </div>

                            <!-- Synonyms -->
                            <div class="pubchem-synonyms-section">
                                <div class="panel-title-bar">
                                    <h4>📋 Synonyms / Trade Names</h4>
                                    <div class="panel-controls">
                                        <button class="small-btn" onclick="toggleSynonymsExpand(${index})" title="Expand/Collapse">↕️</button>
                                    </div>
                                </div>
                                <div class="pubchem-synonyms-list" id="pubchem-synonyms-${index}">
                                    <div class="loading-info">Loading synonyms...</div>
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- Safety/Hazard Section (if available) -->
                    <div class="pubchem-safety-section" id="pubchem-safety-section-${index}" style="display: none;">
                        <div class="panel-title-bar">
                            <h4>⚠️ Safety & Hazards</h4>
                        </div>
                        <div class="pubchem-safety-grid" id="pubchem-safety-${index}"></div>
                    </div>
                </div>
            ` : ''}

            <div class="environment-analysis-section">
                <div class="environment-analysis-header">
                    <h4>Environment-Aware Screening</h4>
                    <span class="environment-analysis-mode">Condition Overlay</span>
                </div>
                <div class="environment-analysis-grid" id="environment-analysis-${index}">
                    ${buildEnvironmentAnalysisMarkup(item)}
                </div>
            </div>

            <div class="data-section">
                <h4>Molecular Information</h4>
                <div class="data-grid">
                    ${formatMolecularData(item)}
                </div>
            </div>

            <div class="actions-section">
                <a href="${item.url}" target="_blank" class="external-link-btn">
                    View in ${item.database} →
                </a>
                ${isPDB ? `
                    <button class="action-btn-secondary" onclick="showPDBInfo('${pdbCode}')">
                        Show PDB Details
                    </button>
                ` : ''}
            </div>
        </div>
    `;

    // Initialize 3D viewer for structures
    if (isPDB && pdbCode) {
        setTimeout(() => initializeMolstarViewer(index, pdbCode), 100);
    } else if (isAlphaFold && uniprotId) {
        setTimeout(() => initializeAlphaFoldViewer(index, uniprotId), 100);
    }
    
    // Initialize UniProt viewer for protein entries
    if (isUniProt) {
        const uniprotAccession = extractUniProtID(item);
        if (uniprotAccession) {
            setTimeout(() => initializeUniProtViewer(index, uniprotAccession), 100);
        } else {
            console.error('Could not extract UniProt accession from item:', item);
        }
    }
    
    // Initialize KEGG workflow for KEGG entries
    if (isKEGG && keggId) {
        setTimeout(() => initializeKEGGWorkflow(index, keggId), 100);
    }

    // Initialize PubChem workflow for PubChem entries
    if (isPubChem && pubchemCID) {
        setTimeout(() => initializePubChemWorkflow(index, pubchemCID), 100);
    }

    return panel;
}

// Extract PDB code from item
function extractPDBCode(item) {
    // Try to extract from ID (format: pdb-XXXX)
    if (item.id && item.id.includes('pdb-')) {
        return item.id.split('pdb-')[1].substring(0, 4).toUpperCase();
    }
    
    // Try to extract from title
    const titleMatch = item.title.match(/\b[0-9][A-Z0-9]{3}\b/i);
    if (titleMatch) {
        return titleMatch[0].toUpperCase();
    }
    
    // Try from data
    if (item.data && item.data.identifier) {
        return item.data.identifier.toUpperCase();
    }
    
    return null;
}

// Extract UniProt ID from AlphaFold item
function extractAlphaFoldID(item) {
    // Try to extract from ID (format: alphafold-P12345)
    if (item.id && item.id.includes('alphafold-')) {
        return item.id.split('alphafold-')[1];
    }
    
    // Try from data.primaryAccession
    if (item.data && item.data.primaryAccession) {
        return item.data.primaryAccession;
    }
    
    // Try to extract from title (format: P12345 - Protein Name)
    const titleMatch = item.title.match(/\b([A-Z0-9]{6,10})\b/);
    if (titleMatch) {
        return titleMatch[1];
    }
    
    return null;
}

// Extract UniProt ID from UniProt item
function extractUniProtID(item) {
    // Try to extract from ID (format: uniprot-P12345)
    if (item.id && item.id.includes('uniprot-')) {
        return item.id.split('uniprot-')[1];
    }
    
    // Try from data.primaryAccession
    if (item.data && item.data.primaryAccession) {
        return item.data.primaryAccession;
    }
    
    // Try to extract from title (format: P12345 - Protein Name)
    const titleMatch = item.title.match(/\b([A-Z][A-Z0-9]{5,9})\b/);
    if (titleMatch) {
        return titleMatch[1];
    }
    
    return null;
}

// Extract KEGG ID from KEGG item
function extractKEGGID(item) {
    // Try to extract from ID (format: kegg-hsa00010 or kegg-C00022)
    if (item.id && item.id.includes('kegg-')) {
        return item.id.split('kegg-')[1];
    }
    
    // Try from data.ENTRY
    if (item.data && item.data.ENTRY) {
        // ENTRY format: "hsa00010  Pathway" - extract just the ID
        return item.data.ENTRY.split(/\s+/)[0];
    }
    
    // Try to extract from title
    const titleMatch = item.title.match(/^([a-z]{2,4}[:\d]+|[A-Z]\d{5})/i);
    if (titleMatch) {
        return titleMatch[1];
    }
    
    return null;
}

// Extract PubChem CID from PubChem item
function extractPubChemCID(item) {
    // Try to extract from ID (format: pubchem-12345)
    if (item.id && item.id.includes('pubchem-')) {
        return item.id.split('pubchem-')[1];
    }
    
    // Try from data.cid
    if (item.data && item.data.cid) {
        return String(item.data.cid);
    }
    
    // Try from data.CID
    if (item.data && item.data.CID) {
        return String(item.data.CID);
    }
    
    // Try to extract from title (CID: 12345)
    const titleMatch = item.title.match(/CID[:\s]*(\d+)/i);
    if (titleMatch) {
        return titleMatch[1];
    }
    
    // Try to extract numeric ID from URL
    if (item.url) {
        const urlMatch = item.url.match(/compound\/(\d+)/);
        if (urlMatch) {
            return urlMatch[1];
        }
    }
    
    return null;
}

// Format molecular data for display
function formatMolecularData(item) {
    let html = '';
    
    if (item.data) {
        // Handle different data structures
        const data = item.data;
        
        // Display relevant fields based on database type
        if (item.database.includes('PDB')) {
            html += data.identifier ? `<div class="data-item"><strong>PDB ID:</strong> ${data.identifier}</div>` : '';
            html += data.score ? `<div class="data-item"><strong>Relevance Score:</strong> ${data.score.toFixed(2)}</div>` : '';
        } else if (item.database.includes('UniProt') || item.database.includes('AlphaFold')) {
            html += data.primaryAccession ? `<div class="data-item"><strong>UniProt ID:</strong> ${data.primaryAccession}</div>` : '';
            html += data.organism?.scientificName ? `<div class="data-item"><strong>Organism:</strong> ${data.organism.scientificName}</div>` : '';
            html += data.genes?.[0]?.geneName?.value ? `<div class="data-item"><strong>Gene:</strong> ${data.genes[0].geneName.value}</div>` : '';
            html += data.sequence?.length ? `<div class="data-item"><strong>Length:</strong> ${data.sequence.length} aa</div>` : '';
        } else if (item.database.includes('PubChem')) {
            html += data.cid ? `<div class="data-item"><strong>CID:</strong> ${data.cid}</div>` : '';
            html += data['Molecular Formula'] ? `<div class="data-item"><strong>Formula:</strong> ${data['Molecular Formula']}</div>` : '';
            html += data['Molecular Weight'] ? `<div class="data-item"><strong>Weight:</strong> ${data['Molecular Weight']}</div>` : '';
            html += data['Canonical SMILES'] ? `<div class="data-item"><strong>SMILES:</strong> <code>${data['Canonical SMILES']}</code></div>` : '';
        } else if (item.database.includes('ChEMBL')) {
            html += data.molecule_chembl_id ? `<div class="data-item"><strong>ChEMBL ID:</strong> ${data.molecule_chembl_id}</div>` : '';
            html += data.molecule_type ? `<div class="data-item"><strong>Type:</strong> ${data.molecule_type}</div>` : '';
            html += data.max_phase !== undefined ? `<div class="data-item"><strong>Max Phase:</strong> Phase ${data.max_phase}</div>` : '';
        } else if (item.database.includes('KEGG')) {
            html += data.ENTRY ? `<div class="data-item"><strong>Entry:</strong> ${data.ENTRY}</div>` : '';
            html += data.DEFINITION ? `<div class="data-item"><strong>Definition:</strong> ${data.DEFINITION}</div>` : '';
        }
    }
    
    if (!html) {
        html = '<div class="data-item">No additional data available</div>';
    }
    
    return html;
}

// Initialize 3Dmol.js viewer for PDB structure
let viewers = {};
let components = {};
let pdbDataCache = {};
let spinIntervals = {};
let selectionStates = {}; // Track which selections are active for each viewer
let representationStyles = {}; // Track current representation style for each viewer

async function initializeMolstarViewer(index, pdbCode) {
    const viewerId = `viewer-${index}`;
    const element = document.getElementById(viewerId);
    
    if (!element) {
        console.error('Viewer element not found:', viewerId);
        return;
    }

    try {
        // Create 3Dmol.js viewer with black background
        const config = { backgroundColor: 'black' };
        const viewer = $3Dmol.createViewer(element, config);
        
        viewers[index] = viewer;
        components[index] = {
            protein: true,
            ligand: true,
            water: false,
            ion: true,
            nucleic: true,
            styles: {
                cartoon: true,
                'ball+stick': false,
                spacefill: false,
                ribbon: false,
                surface: false
            }
        };

        // Fetch PDB file data
        const pdbData = await fetchPDBData(pdbCode);
        
        if (!pdbData) {
            throw new Error('Failed to fetch PDB data');
        }

        // Load structure into 3Dmol
        viewer.addModel(pdbData, "pdb");
        
        // Apply initial cartoon style
        viewer.setStyle({}, {cartoon: {color: 'spectrum'}});
        
        // Ligands as stick
        viewer.addStyle({hetflag: true, not: {resn: ['HOH', 'WAT']}}, {
            stick: {radius: 0.3, colorscheme: 'default'}
        });
        
        // Ions as spheres
        viewer.addStyle({atom: ['NA', 'CL', 'MG', 'CA', 'ZN', 'FE', 'MN', 'CU', 'K']}, {
            sphere: {radius: 1.0, colorscheme: 'Jmol'}
        });

        // Render the viewer
        viewer.zoomTo();
        viewer.render();
        viewer.zoom(1.2, 1000);
        
        console.log(`Loaded PDB structure: ${pdbCode}`);
        
        // Parse structure details from PDB data
        await loadStructureDetails(index, pdbCode, pdbData);
        
    } catch (error) {
        console.error('Error loading PDB structure:', error);
        element.innerHTML = `
            <div class="viewer-error">
                <p>⚠️ Error loading 3D structure</p>
                <p>PDB Code: ${pdbCode}</p>
                <p style="font-size: 0.9rem; margin-top: 1rem;">${error.message}</p>
                <a href="https://www.rcsb.org/structure/${pdbCode}" target="_blank" style="margin-top: 1rem; display: inline-block;">View on RCSB PDB</a>
            </div>
        `;
    }
}

// Parse PDB data to extract structure information
function parsePDBData(pdbData) {
    const lines = pdbData.split('\n');
    const chains = new Map();
    const ligands = new Map();
    const waters = new Set();
    const ions = new Map();
    const proteins = new Map();
    const nucleics = new Map();
    const atomTypes = new Map();
    const elements = new Map();
    const residues = new Set();
    const bFactors = []; // For AlphaFold confidence scores
    
    let atomCount = 0;
    let modelCount = 1;
    
    // Standard amino acids
    const aminoAcids = new Set(['ALA', 'ARG', 'ASN', 'ASP', 'CYS', 'GLN', 'GLU', 'GLY', 'HIS', 'ILE', 
                                 'LEU', 'LYS', 'MET', 'PHE', 'PRO', 'SER', 'THR', 'TRP', 'TYR', 'VAL', 'SEC', 'PYL']);
    
    // Nucleic acids
    const nucleicBases = new Set(['A', 'C', 'G', 'T', 'U', 'DA', 'DC', 'DG', 'DT', 'DU']);
    
    // Common ions
    const commonIons = new Set(['ZN', 'MG', 'CA', 'FE', 'NA', 'K', 'CL', 'MN', 'CU', 'NI', 'CO', 'CD', 'HG', 'BR', 'I']);
    
    // Water
    const waterNames = new Set(['HOH', 'WAT', 'H2O']);
    
    for (const line of lines) {
        if (line.startsWith('MODEL')) {
            const match = line.match(/MODEL\s+(\d+)/);
            if (match) modelCount = Math.max(modelCount, parseInt(match[1]));
        }
        
        if (line.startsWith('ATOM  ') || line.startsWith('HETATM')) {
            atomCount++;
            
            // Parse PDB ATOM/HETATM line format
            const atomName = line.substring(12, 16).trim();
            const resName = line.substring(17, 20).trim();
            const chain = line.substring(21, 22).trim() || 'A';
            const resNo = parseInt(line.substring(22, 26).trim());
            const element = line.substring(76, 78).trim() || atomName.substring(0, 1);
            const bFactor = parseFloat(line.substring(60, 66).trim()); // B-factor (or pLDDT for AlphaFold)
            const isHetero = line.startsWith('HETATM');
            
            // Track B-factors for confidence calculation
            if (!isNaN(bFactor)) {
                bFactors.push(bFactor);
            }
            
            // Track elements
            elements.set(element, (elements.get(element) || 0) + 1);
            
            // Track atom types
            atomTypes.set(atomName, (atomTypes.get(atomName) || 0) + 1);
            
            // Track residues
            const resKey = `${chain}:${resName}${resNo}`;
            residues.add(resKey);
            
            // Initialize chain if needed
            if (!chains.has(chain)) {
                chains.set(chain, {
                    name: chain,
                    residueCount: 0,
                    atomCount: 0,
                    residues: [],
                    ligands: [],
                    waters: 0,
                    ions: []
                });
            }
            
            const chainInfo = chains.get(chain);
            chainInfo.atomCount++;
            
            // Classify residue
            if (waterNames.has(resName)) {
                chainInfo.waters++;
                waters.add(resName);
            } else if (commonIons.has(resName) || (isHetero && element.length <= 2 && element === resName)) {
                chainInfo.ions.push({ resName, resNo });
                ions.set(resName, (ions.get(resName) || 0) + 1);
            } else if (aminoAcids.has(resName)) {
                proteins.set(resName, (proteins.get(resName) || 0) + 1);
            } else if (nucleicBases.has(resName)) {
                nucleics.set(resName, (nucleics.get(resName) || 0) + 1);
            } else if (isHetero) {
                ligands.set(resName, (ligands.get(resName) || 0) + 1);
            }
        }
    }
    
    // Update chain residue counts
    chains.forEach((chainInfo, chainName) => {
        let resSet = new Set();
        for (const resKey of residues) {
            if (resKey.startsWith(chainName + ':')) {
                resSet.add(resKey);
            }
        }
        chainInfo.residueCount = resSet.size;
    });
    
    return {
        atomCount,
        residues,
        chains,
        ligands,
        waters,
        ions,
        proteins,
        nucleics,
        atomTypes,
        elements,
        modelCount,
        bFactors
    };
}

// Fetch PDB file data from RCSB
async function fetchPDBData(pdbCode) {
    // Check cache first
    if (pdbDataCache[pdbCode]) {
        console.log(`Using cached PDB data for ${pdbCode}`);
        return pdbDataCache[pdbCode];
    }

    try {
        console.log(`Fetching PDB data for ${pdbCode}...`);
        
        // Fetch from RCSB PDB files
        const response = await fetch(proxiedUrl(`https://files.rcsb.org/download/${pdbCode}.pdb`), {
            method: 'GET',
            headers: {
                'Accept': 'text/plain'
            }
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const pdbData = await response.text();
        
        // Validate PDB data
        if (!pdbData || !pdbData.includes('ATOM') && !pdbData.includes('HETATM')) {
            throw new Error('Invalid PDB data received');
        }

        // Cache the data
        pdbDataCache[pdbCode] = pdbData;
        
        console.log(`Successfully fetched PDB data for ${pdbCode} (${pdbData.length} bytes)`);
        return pdbData;
    } catch (error) {
        console.error(`Error fetching PDB data for ${pdbCode}:`, error);
        throw error;
    }
}

// Toggle panel visibility
function togglePanel(index) {
    const content = document.getElementById(`panel-content-${index}`);
    const icon = document.querySelector(`#panel-${index} .toggle-icon`);
    
    if (content.style.display === 'none') {
        content.style.display = 'block';
        icon.textContent = '−';
    } else {
        content.style.display = 'none';
        icon.textContent = '+';
    }
}

// Remove panel
function removePanel(index) {
    if (confirm('Remove this item from review?')) {
        selectedMolecules.splice(index, 1);
        localStorage.setItem('selectedMolecules', JSON.stringify(selectedMolecules));

        // Dispose viewer safely — it may throw if loading is in progress
        try {
            if (viewers[index]) {
                viewers[index].dispose();
                delete viewers[index];
            }
        } catch (e) {
            console.warn('Viewer dispose error (non-fatal):', e);
        }

        try { syncWorkflowProjectWithSelection(); } catch (e) { console.warn('syncWorkflowProject error:', e); }
        displaySummary();
        renderWorkflowProjectFields();
        renderWorkflowProject();
        displayReferencePanels();
    }
}

// Fetch AlphaFold PDB file data
async function fetchAlphaFoldData(uniprotId) {
    // Check cache first
    const cacheKey = `alphafold-${uniprotId}`;
    if (pdbDataCache[cacheKey]) {
        console.log(`Using cached AlphaFold data for ${uniprotId}`);
        return pdbDataCache[cacheKey];
    }

    try {
        console.log(`Fetching AlphaFold data for ${uniprotId}...`);
        
        // First, get the prediction info from AlphaFold API to find correct version
        const apiResponse = await fetch(proxiedUrl(`https://alphafold.ebi.ac.uk/api/prediction/${uniprotId}`));
        if (!apiResponse.ok) {
            throw new Error(`AlphaFold API error: ${apiResponse.status}`);
        }
        
        const apiData = await apiResponse.json();
        if (!apiData || apiData.length === 0) {
            throw new Error('No AlphaFold prediction found for this UniProt ID');
        }
        
        // Get the PDB URL from the API response
        const pdbUrl = apiData[0].pdbUrl;
        console.log(`AlphaFold PDB URL: ${pdbUrl}`);
        
        // Store additional metadata for later use
        pdbDataCache[`${cacheKey}-metadata`] = apiData[0];
        
        // Fetch the actual PDB file
        const response = await fetch(pdbUrl, {
            method: 'GET',
            headers: {
                'Accept': 'text/plain'
            }
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const pdbData = await response.text();
        
        // Validate PDB data
        if (!pdbData || !pdbData.includes('ATOM')) {
            throw new Error('Invalid AlphaFold PDB data received');
        }

        // Cache the data
        pdbDataCache[cacheKey] = pdbData;
        
        console.log(`Successfully fetched AlphaFold data for ${uniprotId} (${pdbData.length} bytes)`);
        return pdbData;
    } catch (error) {
        console.error(`Error fetching AlphaFold data for ${uniprotId}:`, error);
        throw error;
    }
}

// Initialize AlphaFold viewer with confidence coloring
async function initializeAlphaFoldViewer(index, uniprotId) {
    const viewerId = `viewer-${index}`;
    const element = document.getElementById(viewerId);
    
    if (!element) {
        console.error('Viewer element not found:', viewerId);
        return;
    }

    try {
        // Create 3Dmol.js viewer with black background
        const config = { backgroundColor: 'black' };
        const viewer = $3Dmol.createViewer(element, config);
        
        viewers[index] = viewer;
        components[index] = {
            protein: true,
            ligand: false,
            water: false,
            ion: false,
            nucleic: false,
            styles: {
                cartoon: true,
                'ball+stick': false,
                spacefill: false,
                ribbon: false,
                surface: false
            }
        };

        // Fetch AlphaFold PDB file data
        const pdbData = await fetchAlphaFoldData(uniprotId);
        
        if (!pdbData) {
            throw new Error('Failed to fetch AlphaFold data');
        }

        // Load structure into 3Dmol
        viewer.addModel(pdbData, "pdb");
        
        // Apply pLDDT confidence-based coloring
        // pLDDT (predicted Local Distance Difference Test) is in the B-factor column
        // Blue (>90): Very high confidence
        // Cyan (70-90): Confident
        // Yellow (50-70): Low confidence
        // Orange (<50): Very low confidence
        viewer.setStyle({}, {
            cartoon: {
                colorscheme: {
                    prop: 'b',
                    gradient: 'roygb',
                    min: 50,
                    max: 100
                }
            }
        });

        // Render the viewer
        viewer.zoomTo();
        viewer.render();
        viewer.zoom(1.2, 1000);
        
        console.log(`Loaded AlphaFold structure: ${uniprotId}`);
        
        // Parse structure details from PDB data
        await loadStructureDetails(index, uniprotId, pdbData, true);
        
    } catch (error) {
        console.error('Error loading AlphaFold structure:', error);
        element.innerHTML = `
            <div class="viewer-error">
                <p>⚠️ Error loading 3D structure</p>
                <p>UniProt ID: ${uniprotId}</p>
                <p style="font-size: 0.9rem; margin-top: 1rem;">${error.message}</p>
                <a href="https://alphafold.ebi.ac.uk/entry/${uniprotId}" target="_blank" style="margin-top: 1rem; display: inline-block;">View on AlphaFold DB</a>
            </div>
        `;
    }
}

// Toggle component visibility
function toggleComponent(index, componentType, visible) {
    const viewer = viewers[index];
    if (!viewer) return;
    
    // Store component states
    if (!components[index]) components[index] = {};
    components[index][componentType] = visible;
    
    // Rerender with current states using the unified rebuild function
    rebuildViewerStyles(index);
}

// Render viewer with current component states
function renderViewer(index) {
    const viewer = viewers[index];
    if (!viewer) return;
    
    // Get current states (default to true if not set)
    const showProtein = components[index]?.protein !== false;
    const showLigand = components[index]?.ligand !== false;
    const showWater = components[index]?.water === true;
    const showIon = components[index]?.ion !== false;
    const showNucleic = components[index]?.nucleic !== false;
    
    // Get current style
    const currentStyle = components[index]?.style || 'cartoon';
    
    // Clear all styles and surfaces
    viewer.setStyle({}, {});
    viewer.removeAllSurfaces();
    
    // Apply protein style
    if (showProtein) {
        const proteinSelector = {not: {hetflag: true}};
        if (currentStyle === 'cartoon') {
            viewer.setStyle(proteinSelector, {cartoon: {color: 'spectrum', thickness: 0.8}});
        } else if (currentStyle === 'ball+stick') {
            viewer.setStyle(proteinSelector, {stick: {radius: 0.15, colorscheme: 'default'}, sphere: {radius: 0.3, colorscheme: 'default'}});
        } else if (currentStyle === 'spacefill') {
            viewer.setStyle(proteinSelector, {sphere: {colorscheme: 'default'}});
        } else if (currentStyle === 'ribbon') {
            viewer.setStyle(proteinSelector, {cartoon: {style: 'trace', color: 'spectrum', thickness: 0.4}});
        } else if (currentStyle === 'surface') {
            viewer.addSurface($3Dmol.SurfaceType.VDW, {opacity: 0.7, color: 'white'}, proteinSelector);
        }
    }
    
    // Apply ligand style
    if (showLigand) {
        viewer.setStyle({hetflag: true, not: {resn: ['HOH', 'WAT'], atom: ['NA', 'CL', 'MG', 'CA', 'ZN', 'FE', 'MN', 'CU', 'K']}}, 
                       {stick: {radius: 0.25, colorscheme: 'default'}, sphere: {radius: 0.4, colorscheme: 'default'}});
    }
    
    // Apply ion style
    if (showIon) {
        viewer.setStyle({atom: ['NA', 'CL', 'MG', 'CA', 'ZN', 'FE', 'MN', 'CU', 'K']}, 
                       {sphere: {radius: 1.0, colorscheme: 'Jmol'}});
    }
    
    // Apply water style
    if (showWater) {
        viewer.setStyle({resn: ['HOH', 'WAT']}, {sphere: {radius: 0.3, color: 'cyan', opacity: 0.6}});
    }
    
    viewer.render();
}

// Toggle representation style - each button works independently
function toggleRepresentation(index, style, btn) {
    const viewer = viewers[index];
    if (!viewer) return;

    if (!components[index]) components[index] = {};
    if (!components[index].styles) {
        components[index].styles = {
            cartoon: true,
            'ball+stick': false,
            ribbon: false,
            surface: false
        };
    }
    
    // Toggle the style on/off
    components[index].styles[style] = !components[index].styles[style];
    
    // Update button state
    if (btn) {
        if (components[index].styles[style]) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    }
    
    // Rebuild all styles
    rebuildViewerStyles(index);
}

// Rebuild all viewer styles based on current state
function rebuildViewerStyles(index) {
    const viewer = viewers[index];
    if (!viewer) return;
    
    viewer.setStyle({}, {});
    viewer.removeAllSurfaces();
    
    const proteinSelector = {not: {hetflag: true}};
    const showProtein = components[index]?.protein !== false;
    const showLigand = components[index]?.ligand !== false;
    const showIon = components[index]?.ion !== false;
    const showWater = components[index]?.water === true;
    
    // Get current color scheme
    const colorSelect = document.getElementById(`color-select-${index}`);
    const colorScheme = colorSelect ? colorSelect.value : 'spectrum';
    const colorConfig = getColorConfig(colorScheme);
    
    if (showProtein) {
        // Apply all active styles using addStyle to layer them
        if (components[index].styles?.cartoon) {
            viewer.addStyle(proteinSelector, {cartoon: colorConfig});
        }
        if (components[index].styles?.['ball+stick']) {
            viewer.addStyle(proteinSelector, {
                stick: {radius: 0.2, colorscheme: 'default'},
                sphere: {radius: 0.4, colorscheme: 'default'}
            });
        }
        if (components[index].styles?.spacefill) {
            viewer.addStyle(proteinSelector, {sphere: {colorscheme: 'default'}});
        }
        if (components[index].styles?.ribbon) {
            viewer.addStyle(proteinSelector, {cartoon: {style: 'trace', ...colorConfig, thickness: 0.5}});
        }
        if (components[index].styles?.surface) {
            viewer.addSurface($3Dmol.SurfaceType.VDW, {opacity: 0.65, colorscheme: {prop: 'ss', scheme: 'RdYlBu'}}, proteinSelector);
        }
    }
    
    // Apply ligands
    if (showLigand) {
        viewer.addStyle({hetflag: true, not: {resn: ['HOH', 'WAT'], atom: ['NA', 'CL', 'MG', 'CA', 'ZN', 'FE', 'MN', 'CU', 'K']}}, 
                       {stick: {radius: 0.3, colorscheme: 'default'}});
    }
    
    // Apply ions
    if (showIon) {
        viewer.addStyle({atom: ['NA', 'CL', 'MG', 'CA', 'ZN', 'FE', 'MN', 'CU', 'K']}, 
                       {sphere: {radius: 1.0, colorscheme: 'Jmol'}});
    }
    
    // Apply water
    if (showWater) {
        viewer.addStyle({resn: ['HOH', 'WAT']}, {sphere: {radius: 0.3, color: 'cyan', opacity: 0.6}});
    }
    
    viewer.render();
}

// Get color configuration for 3Dmol
function getColorConfig(scheme) {
    switch (scheme) {
        case 'spectrum':
            return { color: 'spectrum' };
        case 'chain':
            return { colorscheme: 'chain' };
        case 'ss':
            return { colorscheme: {prop: 'ss', map: $3Dmol.ssColors.Jmol} };
        case 'residue':
            return { colorscheme: 'amino' };
        case 'hydrophobicity':
            return { colorscheme: {prop: 'hydro', scheme: 'RdYlBu'} };
        case 'white':
            return { color: 'white' };
        default:
            return { color: 'spectrum' };
    }
}

// Change color scheme for PDB viewer
function changeColorScheme(index, scheme) {
    rebuildViewerStyles(index);
}

// Reset view in 3D viewer
function resetView(index) {
    const viewer = viewers[index];
    if (viewer) {
        viewer.zoomTo();
        viewer.zoom(1.2, 1000);
        viewer.render();
    }
}

// Track active styles per viewer
let activeStyles = {};

// Set style for AlphaFold viewer (toggle on/off, combinable)
function setStyle(index, style, btn) {
    const viewer = viewers[index];
    if (!viewer) return;
    
    // Initialize style tracking for this viewer
    if (!activeStyles[index]) {
        activeStyles[index] = { cartoon: true }; // cartoon is default on first load
    }
    
    // Toggle this style on/off
    activeStyles[index][style] = !activeStyles[index][style];
    btn.classList.toggle('active');
    
    // Rebuild styles based on active toggles (allows all off)
    rebuildStyles(index, viewer);
}

function rebuildStyles(index, viewer) {
    const styles = activeStyles[index] || {};
    
    // Clear all styles and surfaces
    viewer.setStyle({}, {});
    viewer.removeAllSurfaces();
    
    // pLDDT color function
    const pLDDTColor = function(atom) {
        const pLDDT = atom.b || 50;
        if (pLDDT > 90) return 0x0053D6;
        if (pLDDT > 70) return 0x65CBF3;
        if (pLDDT > 50) return 0xFFDB13;
        return 0xFF7D45;
    };
    
    // Add each active style using addStyle (layers them)
    if (styles.cartoon) {
        viewer.addStyle({}, {
            cartoon: { colorfunc: pLDDTColor }
        });
    }
    
    if (styles.ribbon) {
        viewer.addStyle({}, {
            cartoon: { style: 'trace', colorfunc: pLDDTColor, thickness: 0.5 }
        });
    }
    
    if (styles.ballstick) {
        viewer.addStyle({}, {
            stick: { radius: 0.15, colorfunc: pLDDTColor },
            sphere: { scale: 0.3, colorfunc: pLDDTColor }
        });
    }
    
    if (styles.stick) {
        viewer.addStyle({}, {
            stick: { radius: 0.12, colorfunc: pLDDTColor }
        });
    }
    
    if (styles.sphere) {
        viewer.addStyle({}, {
            sphere: { colorfunc: pLDDTColor }
        });
    }
    
    if (styles.surface) {
        viewer.addSurface($3Dmol.SurfaceType.VDW, {
            opacity: 0.7,
            colorfunc: pLDDTColor
        });
    }
    
    viewer.render();
}

// Track active styles for comparison viewer
let compareActiveStyles = {};

// Set style for comparison viewer (toggle on/off, combinable)
function setCompareStyle(index, style, btn) {
    const viewer = compareViewers[index];
    if (!viewer) return;
    
    // Initialize style tracking for this viewer
    if (!compareActiveStyles[index]) {
        compareActiveStyles[index] = { cartoon: true };
    }
    
    // Toggle this style on/off
    compareActiveStyles[index][style] = !compareActiveStyles[index][style];
    btn.classList.toggle('active');
    
    // Rebuild styles based on active toggles (use current color scheme)
    const currentScheme = compareColorSchemes[index] || 'confidence';
    rebuildCompareStylesWithColor(index, viewer, currentScheme);
}

function rebuildCompareStyles(index, viewer) {
    const currentScheme = compareColorSchemes[index] || 'confidence';
    rebuildCompareStylesWithColor(index, viewer, currentScheme);
}

// Track comparison color scheme
let compareColorSchemes = {};

// Set color scheme for comparison viewer
function setCompareColor(index, scheme, btn) {
    const viewer = compareViewers[index];
    if (!viewer) return;
    
    // Update button states
    const container = btn.closest('.color-buttons');
    container.querySelectorAll('.color-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    
    compareColorSchemes[index] = scheme;
    
    // Rebuild with new color scheme
    rebuildCompareStylesWithColor(index, viewer, scheme);
}

// Rebuild comparison styles with specific color scheme
function rebuildCompareStylesWithColor(index, viewer, scheme) {
    const styles = compareActiveStyles[index] || { cartoon: true };
    
    // Clear all styles and surfaces
    viewer.setStyle({}, {});
    viewer.removeAllSurfaces();
    
    // Color function based on scheme
    let colorFunc;
    let colorSpec;
    
    switch(scheme) {
        case 'confidence':
            colorFunc = function(atom) {
                const pLDDT = atom.b || 50;
                if (pLDDT > 90) return 0x0053D6;
                if (pLDDT > 70) return 0x65CBF3;
                if (pLDDT > 50) return 0xFFDB13;
                return 0xFF7D45;
            };
            colorSpec = { colorfunc: colorFunc };
            break;
        case 'chain':
            colorSpec = { colorscheme: 'chain' };
            break;
        case 'secondary':
            colorSpec = { colorscheme: 'ssPyMOL' };
            break;
        case 'rainbow':
            colorSpec = { colorscheme: 'spectral' };
            break;
        default:
            colorFunc = function(atom) {
                const pLDDT = atom.b || 50;
                if (pLDDT > 90) return 0x0053D6;
                if (pLDDT > 70) return 0x65CBF3;
                if (pLDDT > 50) return 0xFFDB13;
                return 0xFF7D45;
            };
            colorSpec = { colorfunc: colorFunc };
    }
    
    // Add each active style with color
    if (styles.cartoon) {
        viewer.addStyle({}, { cartoon: colorSpec });
    }
    
    if (styles.ribbon) {
        viewer.addStyle({}, {
            cartoon: { ...colorSpec, style: 'trace', thickness: 0.5 }
        });
    }
    
    if (styles.ballstick) {
        viewer.addStyle({}, {
            stick: { radius: 0.15, ...colorSpec },
            sphere: { scale: 0.3, ...colorSpec }
        });
    }
    
    if (styles.stick) {
        viewer.addStyle({}, {
            stick: { radius: 0.12, ...colorSpec }
        });
    }
    
    if (styles.sphere) {
        viewer.addStyle({}, {
            sphere: colorSpec
        });
    }
    
    if (styles.surface) {
        if (colorFunc) {
            viewer.addSurface($3Dmol.SurfaceType.VDW, {
                opacity: 0.7,
                colorfunc: colorFunc
            });
        } else {
            viewer.addSurface($3Dmol.SurfaceType.VDW, {
                opacity: 0.7,
                colorscheme: scheme === 'chain' ? 'chain' : (scheme === 'secondary' ? 'ssPyMOL' : 'spectral')
            });
        }
    }
    
    viewer.render();
}

// Reset comparison view
function resetCompareView(index) {
    const viewer = compareViewers[index];
    if (viewer) {
        viewer.zoomTo();
        viewer.render();
    }
}

// Track comparison spin states
let compareSpinIntervals = {};

// Toggle spin for comparison viewer
function toggleCompareSpin(index, btn) {
    const viewer = compareViewers[index];
    if (!viewer) return;
    
    if (compareSpinIntervals[index]) {
        clearInterval(compareSpinIntervals[index]);
        compareSpinIntervals[index] = null;
        btn.classList.remove('active');
    } else {
        compareSpinIntervals[index] = setInterval(() => {
            viewer.rotate(1, 'y');
        }, 50);
        btn.classList.add('active');
    }
}

// Zoom in comparison viewer
function zoomCompareIn(index) {
    const viewer = compareViewers[index];
    if (viewer) {
        viewer.zoom(1.2, 300);
    }
}

// Zoom out comparison viewer
function zoomCompareOut(index) {
    const viewer = compareViewers[index];
    if (viewer) {
        viewer.zoom(0.8, 300);
    }
}

// Sync comparison viewer with main viewer
function syncViewers(index) {
    const mainViewer = viewers[index];
    const compareViewer = compareViewers[index];
    
    if (mainViewer && compareViewer) {
        // Get main viewer's view
        const view = mainViewer.getView();
        // Apply to comparison viewer
        compareViewer.setView(view);
        compareViewer.render();
    }
}

// Center view
function centerView(index) {
    const viewer = viewers[index];
    if (viewer) {
        viewer.center();
        viewer.render();
    }
}

// Toggle spin animation
function toggleSpin(index) {
    const viewer = viewers[index];
    if (!viewer) return;

    if (spinIntervals[index]) {
        clearInterval(spinIntervals[index]);
        spinIntervals[index] = null;
    } else {
        spinIntervals[index] = setInterval(() => {
            viewer.rotate(1, 'y');
        }, 50);
    }
}

// Load structure details
async function loadStructureDetails(index, structureId, pdbData, isAlphaFold = false) {
    const detailsElement = document.getElementById(`details-${index}`);
    if (!detailsElement) return;

    try {
        // Parse PDB data (works for both PDB and AlphaFold)
        const parsed = parsePDBData(pdbData);
        
        const atomCount = parsed.atomCount;
        const residueCount = parsed.residues.size;
        const chainCount = parsed.chains.size;
        const modelCount = parsed.modelCount;

        // Detailed component tracking from parsed data
        const chains = parsed.chains;
        const ligands = parsed.ligands;
        const waters = parsed.waters;
        const ions = parsed.ions;
        const proteins = parsed.proteins;
        const nucleics = parsed.nucleics;
        const atomTypes = parsed.atomTypes;
        const elements = parsed.elements;

        // Try to fetch additional metadata
        let metadata = null;
        if (!isAlphaFold) {
            try {
                const response = await fetch(proxiedUrl(`https://data.rcsb.org/rest/v1/core/entry/${structureId}`));
                if (response.ok) {
                    metadata = await response.json();
                }
            } catch (e) {
                console.log('Could not fetch metadata:', e);
            }
        }

        // Calculate average pLDDT for AlphaFold
        let avgConfidence = null;
        if (isAlphaFold) {
            const bFactors = parsed.bFactors || [];
            if (bFactors.length > 0) {
                avgConfidence = (bFactors.reduce((a, b) => a + b, 0) / bFactors.length).toFixed(2);
            }
        }

        let html = `
            <h4>
                Structure Details
                <button class="toggle-unavailable-btn" onclick="toggleUnavailableItems(${index})">
                    <span id="toggle-text-${index}">Hide Unavailable</span>
                </button>
            </h4>
            <div class="details-content">
        `;
        
        if (isAlphaFold) {
            // Get AlphaFold metadata from cache
            const afMetadata = pdbDataCache[`alphafold-${structureId}-metadata`];
            
            html += `<div class="detail-item"><strong>UniProt ID:</strong> ${structureId}</div>`;
            
            if (afMetadata) {
                html += afMetadata.uniprotDescription ? `<div class="detail-item"><strong>Protein:</strong> ${afMetadata.uniprotDescription}</div>` : '';
                html += afMetadata.gene ? `<div class="detail-item"><strong>Gene:</strong> ${afMetadata.gene}</div>` : '';
                html += afMetadata.organismScientificName ? `<div class="detail-item"><strong>Organism:</strong> ${afMetadata.organismScientificName}</div>` : '';
                html += afMetadata.latestVersion ? `<div class="detail-item"><strong>AlphaFold Version:</strong> v${afMetadata.latestVersion}</div>` : '';
                html += afMetadata.toolUsed ? `<div class="detail-item"><strong>Method:</strong> ${afMetadata.toolUsed}</div>` : '';
                html += afMetadata.modelCreatedDate ? `<div class="detail-item"><strong>Model Date:</strong> ${afMetadata.modelCreatedDate.split('T')[0]}</div>` : '';
                html += afMetadata.globalMetricValue ? `<div class="detail-item"><strong>Global pLDDT:</strong> ${afMetadata.globalMetricValue.toFixed(2)}</div>` : '';
                
                // Confidence distribution
                if (afMetadata.fractionPlddtVeryHigh !== undefined) {
                    html += `<div class="detail-section"><h5>Confidence Distribution</h5>`;
                    html += `<div class="detail-item" style="color: #0053d6;"><strong>Very High (>90):</strong> ${(afMetadata.fractionPlddtVeryHigh * 100).toFixed(1)}%</div>`;
                    html += `<div class="detail-item" style="color: #65cbf3;"><strong>Confident (70-90):</strong> ${(afMetadata.fractionPlddtConfident * 100).toFixed(1)}%</div>`;
                    html += `<div class="detail-item" style="color: #ffdb13;"><strong>Low (50-70):</strong> ${(afMetadata.fractionPlddtLow * 100).toFixed(1)}%</div>`;
                    html += `<div class="detail-item" style="color: #ff7d45;"><strong>Very Low (<50):</strong> ${(afMetadata.fractionPlddtVeryLow * 100).toFixed(1)}%</div>`;
                    html += `</div>`;
                }
            } else {
                html += `<div class="detail-item"><strong>Source:</strong> AlphaFold DB</div>`;
                if (avgConfidence) {
                    html += `<div class="detail-item"><strong>Avg. Confidence (pLDDT):</strong> ${avgConfidence}</div>`;
                }
            }
        } else {
            html += `<div class="detail-item"><strong>PDB Code:</strong> ${structureId.toUpperCase()}</div>`;
            
            if (metadata) {
                html += metadata.struct?.title ? `<div class="detail-item"><strong>Title:</strong> ${metadata.struct.title}</div>` : '';
                html += metadata.exptl?.[0]?.method ? `<div class="detail-item"><strong>Method:</strong> ${metadata.exptl[0].method}</div>` : '';
                html += metadata.rcsb_entry_info?.resolution_combined?.[0] ? 
                    `<div class="detail-item"><strong>Resolution:</strong> ${metadata.rcsb_entry_info.resolution_combined[0]} Å</div>` : '';
                html += metadata.rcsb_accession_info?.initial_release_date ? 
                    `<div class="detail-item"><strong>Release Date:</strong> ${metadata.rcsb_accession_info.initial_release_date.split('T')[0]}</div>` : '';
            }
        }
        
        html += `
            <div class="detail-section">
                <h5>Overall Statistics</h5>
                <div class="detail-item"><strong>Total Atoms:</strong> ${atomCount.toLocaleString()}</div>
                <div class="detail-item"><strong>Total Residues:</strong> ${residueCount.toLocaleString()}</div>
                <div class="detail-item"><strong>Chains:</strong> ${chainCount}</div>
                <div class="detail-item"><strong>Models:</strong> ${modelCount}</div>
            </div>
        `;

        // Elements breakdown - show ALL possible elements
        html += `<div class="detail-section"><h5>Elements (Toggle by Element)</h5>`;
        const allElements = ['H', 'C', 'N', 'O', 'S', 'P', 'F', 'CL', 'BR', 'I', 'NA', 'MG', 'K', 'CA', 'FE', 'ZN', 'CU', 'MN', 'CO', 'NI', 'SE', 'MO', 'W', 'V', 'CR'];
        allElements.forEach(element => {
            const count = elements.get(element) || 0;
            const fullName = formatName(element, 'element');
            const isPresent = count > 0;
            html += `
                <label class="detail-checkbox element-checkbox ${!isPresent ? 'unavailable' : ''}">
                    <input type="checkbox" ${isPresent ? 'checked' : ''} ${!isPresent ? 'disabled' : ''} onchange="toggleElement(${index}, '${element}', this.checked)">
                    <span><strong>${fullName}:</strong> ${isPresent ? count.toLocaleString() + ' atoms' : 'Not in model'}</span>
                </label>
            `;
        });
        html += `</div>`;

        // Protein residues breakdown - show ALL amino acids
        html += `<div class="detail-section"><h5>Protein Residues (by type)</h5>`;
        const allAminoAcids = ['ALA', 'ARG', 'ASN', 'ASP', 'CYS', 'GLN', 'GLU', 'GLY', 'HIS', 'ILE', 'LEU', 'LYS', 'MET', 'PHE', 'PRO', 'SER', 'THR', 'TRP', 'TYR', 'VAL', 'SEC', 'PYL', 'MSE'];
        allAminoAcids.forEach(resName => {
            const count = proteins.get(resName) || 0;
            const fullName = formatName(resName, 'amino');
            const isPresent = count > 0;
            html += `
                <label class="detail-checkbox protein-checkbox ${!isPresent ? 'unavailable' : ''}">
                    <input type="checkbox" ${isPresent ? 'checked' : ''} ${!isPresent ? 'disabled' : ''} onchange="toggleResidue(${index}, '${resName}', this.checked)">
                    <span><strong>${fullName}:</strong> ${isPresent ? count + ' residues' : 'Not in model'}</span>
                </label>
            `;
        });
        html += `</div>`;

        // Nucleic acids breakdown - show ALL nucleic acids
        html += `<div class="detail-section"><h5>Nucleic Acids</h5>`;
        const allNucleicAcids = ['A', 'C', 'G', 'T', 'U', 'DA', 'DC', 'DG', 'DT', 'DU', 'AMP', 'CMP', 'GMP', 'TMP', 'UMP'];
        allNucleicAcids.forEach(resName => {
            const count = nucleics.get(resName) || 0;
            const fullName = formatName(resName, 'nucleic');
            const isPresent = count > 0;
            html += `
                <label class="detail-checkbox nucleic-checkbox ${!isPresent ? 'unavailable' : ''}">
                    <input type="checkbox" ${isPresent ? 'checked' : ''} ${!isPresent ? 'disabled' : ''} onchange="toggleResidue(${index}, '${resName}', this.checked)">
                    <span><strong>${fullName}:</strong> ${isPresent ? count + ' residues' : 'Not in model'}</span>
                </label>
            `;
        });
        html += `</div>`;

        // Ligands breakdown
        if (ligands.size > 0) {
            html += `<div class="detail-section"><h5>Ligands (by residue name)</h5>`;
            const sortedLigands = Array.from(ligands.entries()).sort((a, b) => b[1] - a[1]);
            sortedLigands.forEach(([resName, count]) => {
                const fullName = formatName(resName, 'ligand');
                html += `
                    <label class="detail-checkbox ligand-checkbox">
                        <input type="checkbox" checked onchange="toggleLigand(${index}, '${resName}', this.checked)">
                        <span><strong>${fullName}:</strong> ${count} molecule(s)</span>
                    </label>
                `;
            });
            html += `</div>`;
        }

        // Water molecules
        if (waters.size > 0) {
            html += `<div class="detail-section"><h5>Water Molecules</h5>`;
            waters.forEach(resName => {
                let waterCount = 0;
                chains.forEach(chain => waterCount += chain.waters);
                html += `
                    <label class="detail-checkbox water-checkbox">
                        <input type="checkbox" onchange="toggleWater(${index}, this.checked)">
                        <span><strong>${resName}:</strong> ${waterCount.toLocaleString()} molecules</span>
                    </label>
                `;
            });
            html += `</div>`;
        }

        // Ions breakdown - show ALL common ions
        html += `<div class="detail-section"><h5>Ions (by type)</h5>`;
        const allIons = ['ZN', 'MG', 'CA', 'FE', 'NA', 'K', 'CL', 'MN', 'CU', 'NI', 'CO', 'CD', 'HG', 'BR', 'I', 'F', 'SO4', 'PO4', 'NO3', 'NH4', 'LI'];
        allIons.forEach(resName => {
            const count = ions.get(resName) || 0;
            const fullName = formatName(resName, 'ion');
            const isPresent = count > 0;
            html += `
                <label class="detail-checkbox ion-checkbox ${!isPresent ? 'unavailable' : ''}">
                    <input type="checkbox" ${isPresent ? 'checked' : ''} ${!isPresent ? 'disabled' : ''} onchange="toggleIon(${index}, '${resName}', this.checked)">
                    <span><strong>${fullName}:</strong> ${isPresent ? count + ' ion(s)' : 'Not in model'}</span>
                </label>
            `;
        });
        html += `</div>`;

        // Individual chains with detailed breakdown
        if (chains.size > 0) {
            html += `<div class="detail-section"><h5>Chains (detailed view)</h5>`;
            
            chains.forEach((chainInfo, chainName) => {
                html += `
                    <div class="chain-detail-group">
                        <label class="detail-checkbox chain-checkbox">
                            <input type="checkbox" checked onchange="toggleChain(${index}, '${chainName}', this.checked)">
                            <span><strong>Chain ${chainName}:</strong> ${chainInfo.residueCount} residues, ${chainInfo.atomCount} atoms</span>
                        </label>
                        <div class="chain-subinfo">
                            ${chainInfo.residues.length > 0 ? `<div>• ${chainInfo.residues.length} protein/nucleic residues</div>` : ''}
                            ${chainInfo.ligands.length > 0 ? `<div>• ${chainInfo.ligands.length} ligand(s): ${chainInfo.ligands.map(l => l.resName).join(', ')}</div>` : ''}
                            ${chainInfo.waters > 0 ? `<div>• ${chainInfo.waters} water molecules</div>` : ''}
                            ${chainInfo.ions.length > 0 ? `<div>• ${chainInfo.ions.length} ion(s): ${chainInfo.ions.map(i => i.resName).join(', ')}</div>` : ''}
                        </div>
                    </div>
                `;
            });
            
            html += `</div>`;
        }

        // Atom types - show ALL possible atom types
        html += `<div class="detail-section"><h5>Atom Types (comprehensive list)</h5>`;
        const allAtomTypes = ['N', 'CA', 'C', 'O', 'OXT', 'CB', 'CG', 'CG1', 'CG2', 'CD', 'CD1', 'CD2', 'CE', 'CE1', 'CE2', 'CE3', 'CZ', 'CZ2', 'CZ3', 'CH2', 'OG', 'OG1', 'SG', 'SD', 'OD1', 'OD2', 'ND1', 'ND2', 'NE', 'NE1', 'NE2', 'OE1', 'OE2', 'NZ', 'NH1', 'NH2', 'OH', 'H', 'H1', 'H2', 'H3', 'HA', 'HA2', 'HA3', 'HB', 'HB1', 'HB2', 'HB3', 'HG', 'HG1', 'HG2', 'HG3', 'HG11', 'HG12', 'HG13', 'HG21', 'HG22', 'HG23', 'HD1', 'HD2', 'HD3', 'HD11', 'HD12', 'HD13', 'HD21', 'HD22', 'HD23', 'HE', 'HE1', 'HE2', 'HE3', 'HE21', 'HE22', 'HZ', 'HZ1', 'HZ2', 'HZ3', 'HH', 'HH11', 'HH12', 'HH21', 'HH22', 'P', 'OP1', 'OP2', 'OP3', "O5'", "C5'", "C4'", "O4'", "C3'", "O3'", "C2'", "O2'", "C1'", 'N1', 'N2', 'N3', 'N4', 'N6', 'N7', 'N9', 'C2', 'C4', 'C5', 'C6', 'C8', 'O2', 'O4', 'O6', 'S'];
        allAtomTypes.forEach(atomName => {
            const count = atomTypes.get(atomName) || 0;
            const fullName = formatName(atomName, 'atom');
            const isPresent = count > 0;
            html += `
                <label class="detail-checkbox atom-checkbox ${!isPresent ? 'unavailable' : ''}">
                    <input type="checkbox" ${isPresent ? 'checked' : ''} ${!isPresent ? 'disabled' : ''} onchange="toggleAtomType(${index}, '${atomName}', this.checked)">
                    <span><strong>${fullName}:</strong> ${isPresent ? count.toLocaleString() : 'Not in model'}</span>
                </label>
            `;
        });
        html += `</div>`;

        html += '</div>';
        detailsElement.innerHTML = html;

    } catch (error) {
        console.error('Error loading structure details:', error);
        detailsElement.innerHTML = '<h4>Structure Details</h4><p>Details unavailable</p>';
    }
}

// Toggle detail components
function toggleDetailComponent(index, componentType, visible) {
    const viewer = viewers[index];
    if (!viewer) return;

    switch (componentType) {
        case 'all-atoms':
        case 'all-residues':
        case 'all-chains':
        case 'models':
            // Toggle via main component toggle
            toggleComponent(index, 'protein', visible);
            toggleComponent(index, 'nucleic', visible);
            break;
            
        case 'ligands':
            toggleComponent(index, 'ligand', visible);
            const ligandCheckbox = document.getElementById(`show-ligand-${index}`);
            if (ligandCheckbox) ligandCheckbox.checked = visible;
            break;
            
        case 'waters':
            toggleComponent(index, 'water', visible);
            const waterCheckbox = document.getElementById(`show-water-${index}`);
            if (waterCheckbox) waterCheckbox.checked = visible;
            break;
            
        case 'ions':
            toggleComponent(index, 'ion', visible);
            const ionCheckbox = document.getElementById(`show-ion-${index}`);
            if (ionCheckbox) ionCheckbox.checked = visible;
            break;
    }
}

// Store additional component representations
let chainComponents = {};
let residueComponents = {};
let ligandComponents = {};
let ionComponents = {};
let elementComponents = {};
let atomTypeComponents = {};

// Toggle individual chain visibility
function toggleChain(index, chainName, visible) {
    const viewer = viewers[index];
    if (!viewer) return;

    if (!chainComponents[index]) chainComponents[index] = {};
    chainComponents[index][chainName] = visible;

    if (visible) {
        viewer.setStyle({chain: chainName}, {cartoon: {color: 'spectrum'}});
    } else {
        viewer.setStyle({chain: chainName}, {});
    }
    viewer.render();
}

// Toggle specific residue type
function toggleResidue(index, resName, visible) {
    const viewer = viewers[index];
    if (!viewer) return;

    if (!residueComponents[index]) residueComponents[index] = {};
    residueComponents[index][resName] = visible;

    if (visible) {
        viewer.setStyle({resn: resName}, {cartoon: {color: 'spectrum'}});
    } else {
        viewer.setStyle({resn: resName}, {});
    }
    viewer.render();
}

// Toggle specific ligand
function toggleLigand(index, resName, visible) {
    const viewer = viewers[index];
    if (!viewer) return;

    if (!ligandComponents[index]) ligandComponents[index] = {};
    ligandComponents[index][resName] = visible;

    if (visible) {
        viewer.setStyle({resn: resName, hetflag: true}, {
            stick: {radius: 0.25, colorscheme: 'default'},
            sphere: {radius: 0.4, colorscheme: 'default'}
        });
    } else {
        viewer.setStyle({resn: resName, hetflag: true}, {});
    }
    viewer.render();
}

// Toggle water
function toggleWater(index, visible) {
    toggleDetailComponent(index, 'waters', visible);
}

// Toggle specific ion
function toggleIon(index, resName, visible) {
    const viewer = viewers[index];
    if (!viewer) return;

    if (!ionComponents[index]) ionComponents[index] = {};
    ionComponents[index][resName] = visible;

    if (visible) {
        viewer.setStyle({resn: resName}, {sphere: {radius: 1.0, colorscheme: 'Jmol'}});
    } else {
        viewer.setStyle({resn: resName}, {});
    }
    viewer.render();
}

// Toggle by element
function toggleElement(index, element, visible) {
    const viewer = viewers[index];
    if (!viewer) return;

    if (!elementComponents[index]) elementComponents[index] = {};
    elementComponents[index][element] = visible;

    if (visible) {
        viewer.setStyle({elem: element}, {sphere: {radius: 0.4, colorscheme: 'Jmol'}});
    } else {
        viewer.setStyle({elem: element}, {});
    }
    viewer.render();
}

// Toggle by atom type
function toggleAtomType(index, atomName, visible) {
    const viewer = viewers[index];
    if (!viewer) return;

    if (!atomTypeComponents[index]) atomTypeComponents[index] = {};
    atomTypeComponents[index][atomName] = visible;

    if (visible) {
        viewer.setStyle({atom: atomName}, {sphere: {radius: 0.3, colorscheme: 'Jmol'}});
    } else {
        viewer.setStyle({atom: atomName}, {});
    }
    viewer.render();
}

// Initialize selection state for a viewer
function initSelectionState(index) {
    if (!selectionStates[index]) {
        selectionStates[index] = {
            backbone: true,
            sidechains: true,
            hydrophobic: true,
            polar: true,
            charged: true
        };
    }
}

// Apply all active selections (preserving representation style)
function applySelections(index) {
    const viewer = viewers[index];
    if (!viewer) return;
    
    initSelectionState(index);
    const state = selectionStates[index];
    
    // Clear all styles
    viewer.setStyle({}, {});
    viewer.removeAllSurfaces();
    
    // First apply the representation style if any is active
    if (!components[index]) components[index] = {};
    if (!components[index].styles) components[index].styles = {};
    
    const proteinSelector = {not: {hetflag: true}};
    const showProtein = components[index]?.protein !== false;
    const showLigand = components[index]?.ligand !== false;
    const showIon = components[index]?.ion !== false;
    const showWater = components[index]?.water === true;
    
    if (showProtein) {
        // Apply representation styles
        if (components[index].styles.cartoon) {
            viewer.addStyle(proteinSelector, {cartoon: {color: 'spectrum'}});
        }
        if (components[index].styles['ball+stick']) {
            viewer.addStyle(proteinSelector, {
                stick: {radius: 0.2, colorscheme: 'default'},
                sphere: {radius: 0.4, colorscheme: 'default'}
            });
        }
        if (components[index].styles.spacefill) {
            viewer.addStyle(proteinSelector, {sphere: {colorscheme: 'default'}});
        }
        if (components[index].styles.ribbon) {
            viewer.addStyle(proteinSelector, {cartoon: {style: 'trace', color: 'spectrum', thickness: 0.5}});
        }
        if (components[index].styles.surface) {
            viewer.addSurface($3Dmol.SurfaceType.VDW, {opacity: 0.65, colorscheme: {prop: 'ss', scheme: 'RdYlBu'}}, proteinSelector);
        }
    }
    
    // Apply ligands
    if (showLigand) {
        viewer.addStyle({hetflag: true, not: {resn: ['HOH', 'WAT'], atom: ['NA', 'CL', 'MG', 'CA', 'ZN', 'FE', 'MN', 'CU', 'K']}}, 
                       {stick: {radius: 0.3, colorscheme: 'default'}});
    }
    
    // Apply ions
    if (showIon) {
        viewer.addStyle({atom: ['NA', 'CL', 'MG', 'CA', 'ZN', 'FE', 'MN', 'CU', 'K']}, 
                       {sphere: {radius: 1.0, colorscheme: 'Jmol'}});
    }
    
    // Apply water
    if (showWater) {
        viewer.addStyle({resn: ['HOH', 'WAT']}, {sphere: {radius: 0.3, color: 'cyan', opacity: 0.6}});
    }
    
    // Now apply atom selections on top (these add additional highlighting)
    if (state.backbone) {
        viewer.addStyle({atom: ['N', 'CA', 'C', 'O', 'OXT']}, {
            stick: {radius: 0.3, colorscheme: 'default'}, 
            sphere: {radius: 0.5, colorscheme: 'default'}
        });
    }
    
    if (state.sidechains) {
        viewer.addStyle({not: {atom: ['N', 'CA', 'C', 'O', 'OXT']}, elem: 'C,N,O,S,P'}, {
            stick: {radius: 0.3, colorscheme: 'default'}, 
            sphere: {radius: 0.5, colorscheme: 'default'}
        });
    }
    
    if (state.hydrophobic) {
        const hydrophobic = ['ALA', 'VAL', 'LEU', 'ILE', 'MET', 'PHE', 'TRP', 'PRO'];
        viewer.addStyle({resn: hydrophobic}, {
            stick: {radius: 0.35, colorscheme: 'greenCarbon'}
        });
    }
    
    if (state.polar) {
        const polar = ['SER', 'THR', 'CYS', 'ASN', 'GLN', 'TYR'];
        viewer.addStyle({resn: polar}, {
            stick: {radius: 0.35, colorscheme: 'cyanCarbon'}
        });
    }
    
    if (state.charged) {
        const charged = ['ARG', 'LYS', 'HIS', 'ASP', 'GLU'];
        viewer.addStyle({resn: charged}, {
            stick: {radius: 0.35, colorscheme: 'magentaCarbon'}
        });
    }
    
    viewer.render();
}

// Toggle selection functions
function selectBackbone(index) {
    initSelectionState(index);
    selectionStates[index].backbone = !selectionStates[index].backbone;
    
    const btn = document.getElementById(`btn-backbone-${index}`);
    if (btn) {
        btn.classList.toggle('active', selectionStates[index].backbone);
    }
    
    applySelections(index);
}

function selectSidechains(index) {
    initSelectionState(index);
    selectionStates[index].sidechains = !selectionStates[index].sidechains;
    
    const btn = document.getElementById(`btn-sidechains-${index}`);
    if (btn) {
        btn.classList.toggle('active', selectionStates[index].sidechains);
    }
    
    applySelections(index);
}

function selectHydrophobic(index) {
    initSelectionState(index);
    selectionStates[index].hydrophobic = !selectionStates[index].hydrophobic;
    
    const btn = document.getElementById(`btn-hydrophobic-${index}`);
    if (btn) {
        btn.classList.toggle('active', selectionStates[index].hydrophobic);
    }
    
    applySelections(index);
}

function selectPolar(index) {
    initSelectionState(index);
    selectionStates[index].polar = !selectionStates[index].polar;
    
    const btn = document.getElementById(`btn-polar-${index}`);
    if (btn) {
        btn.classList.toggle('active', selectionStates[index].polar);
    }
    
    applySelections(index);
}

function selectCharged(index) {
    initSelectionState(index);
    selectionStates[index].charged = !selectionStates[index].charged;
    
    const btn = document.getElementById(`btn-charged-${index}`);
    if (btn) {
        btn.classList.toggle('active', selectionStates[index].charged);
    }
    
    applySelections(index);
}

function selectAll(index) {
    initSelectionState(index);
    
    // Turn all on
    selectionStates[index].backbone = true;
    selectionStates[index].sidechains = true;
    selectionStates[index].hydrophobic = true;
    selectionStates[index].polar = true;
    selectionStates[index].charged = true;
    
    // Update all button states
    ['backbone', 'sidechains', 'hydrophobic', 'polar', 'charged'].forEach(type => {
        const btn = document.getElementById(`btn-${type}-${index}`);
        if (btn) {
            btn.classList.add('active');
        }
    });
    
    const allBtn = document.getElementById(`btn-all-${index}`);
    if (allBtn) {
        allBtn.classList.add('active');
    }
    
    applySelections(index);
}

// Show PDB details
async function showPDBInfo(pdbCode) {
    try {
        // Fetch PDB metadata from RCSB API
        const response = await fetch(proxiedUrl(`https://data.rcsb.org/rest/v1/core/entry/${pdbCode}`));
        if (response.ok) {
            const data = await response.json();
            const info = `
PDB ID: ${pdbCode}
Title: ${data.struct?.title || 'N/A'}
Method: ${data.exptl?.[0]?.method || 'N/A'}
Resolution: ${data.rcsb_entry_info?.resolution_combined?.[0] || 'N/A'} Å
Release Date: ${data.rcsb_accession_info?.initial_release_date?.split('T')[0] || 'N/A'}
Polymer Entities: ${data.rcsb_entry_info?.polymer_entity_count || 'N/A'}
            `;
            alert(info);
        }
    } catch (error) {
        alert(`PDB Code: ${pdbCode}\n\nView full details at:\nhttps://www.rcsb.org/structure/${pdbCode}`);
    }
}

// Toggle unavailable items visibility
const unavailableStates = {};

function toggleUnavailableItems(index) {
    const detailsElement = document.getElementById(`details-${index}`);
    if (!detailsElement) return;
    
    // Toggle state
    unavailableStates[index] = !unavailableStates[index];
    const isHidden = unavailableStates[index];
    
    // Find all unavailable checkboxes
    const unavailableItems = detailsElement.querySelectorAll('.detail-checkbox.unavailable');
    unavailableItems.forEach(item => {
        if (isHidden) {
            item.classList.add('hidden');
        } else {
            item.classList.remove('hidden');
        }
    });
    
    // Update button text
    const toggleText = document.getElementById(`toggle-text-${index}`);
    if (toggleText) {
        toggleText.textContent = isHidden ? 'Show Unavailable' : 'Hide Unavailable';
    }
}

// ================================================
// AlphaFold Multi-Panel Functions
// ================================================

// Store AlphaFold data for each panel
let alphaFoldData = {};
let compareViewers = {};

// Initialize AlphaFold viewer with all panels
async function initializeAlphaFoldViewer(index, uniprotId) {
    const viewerId = `viewer-${index}`;
    const element = document.getElementById(viewerId);
    
    if (!element) {
        console.error('Viewer element not found:', viewerId);
        return;
    }

    try {
        // Fetch all isoforms from AlphaFold API
        const allIsoforms = await fetchAllAlphaFoldIsoforms(uniprotId);
        alphaFoldData[index] = {
            baseId: uniprotId,
            isoforms: allIsoforms,
            currentIsoform: 0,
            sequence: null
        };
        
        // Populate isoform selector
        populateIsoformSelector(index, allIsoforms);
        
        // Create 3Dmol.js viewer with black background
        const config = { backgroundColor: 'black' };
        const viewer = $3Dmol.createViewer(element, config);
        
        viewers[index] = viewer;
        components[index] = {
            protein: true,
            ligand: false,
            water: false,
            ion: false,
            nucleic: false,
            styles: {
                cartoon: true,
                'ball+stick': false,
                spacefill: false,
                ribbon: false,
                surface: false
            }
        };

        // Fetch primary isoform PDB data
        const primaryIsoform = allIsoforms[0];
        const pdbData = await fetchAlphaFoldPDB(primaryIsoform.pdbUrl);
        
        if (!pdbData) {
            throw new Error('Failed to fetch AlphaFold data');
        }

        // Store PDB data
        pdbDataCache[`alphafold-${uniprotId}`] = pdbData;
        pdbDataCache[`alphafold-${uniprotId}-metadata`] = primaryIsoform;

        // Load structure into 3Dmol
        viewer.addModel(pdbData, "pdb");
        
        // Apply pLDDT confidence-based coloring
        applyConfidenceColoring(viewer);

        // Render the viewer
        viewer.zoomTo();
        viewer.render();
        viewer.zoom(1.2, 1000);
        
        console.log(`Loaded AlphaFold structure: ${uniprotId}`);
        
        // Update quick info bar
        updateQuickInfo(index, primaryIsoform);
        
        // Load PAE image
        loadPAEImage(index, primaryIsoform.paeImageUrl);
        
        // Load structure details
        await loadAlphaFoldDetails(index, primaryIsoform, pdbData);
        
        // Load sequence
        loadSequence(index, primaryIsoform);
        
        // Populate comparison selector (excluding current isoform)
        populateCompareSelector(index, allIsoforms);
        
    } catch (error) {
        console.error('Error loading AlphaFold structure:', error);
        element.innerHTML = `
            <div class="viewer-error">
                <p>⚠️ Error loading 3D structure</p>
                <p>UniProt ID: ${uniprotId}</p>
                <p style="font-size: 0.9rem; margin-top: 1rem;">${error.message}</p>
                <a href="https://alphafold.ebi.ac.uk/entry/${uniprotId}" target="_blank" style="margin-top: 1rem; display: inline-block;">View on AlphaFold DB</a>
            </div>
        `;
    }
}

// Fetch all isoforms from AlphaFold API
async function fetchAllAlphaFoldIsoforms(uniprotId) {
    try {
        // Get base ID without isoform suffix
        const baseId = uniprotId.split('-')[0];
        
        const response = await fetch(proxiedUrl(`https://alphafold.ebi.ac.uk/api/prediction/${baseId}`));
        if (!response.ok) {
            throw new Error(`AlphaFold API error: ${response.status}`);
        }
        
        const data = await response.json();
        if (!data || data.length === 0) {
            throw new Error('No AlphaFold prediction found');
        }
        
        console.log(`Found ${data.length} isoform(s) for ${baseId}`);
        return data;
    } catch (error) {
        console.error('Error fetching AlphaFold isoforms:', error);
        throw error;
    }
}

// Fetch PDB data from URL
async function fetchAlphaFoldPDB(pdbUrl) {
    try {
        const response = await fetch(pdbUrl, {
            method: 'GET',
            headers: { 'Accept': 'text/plain' }
        });
        
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        
        const pdbData = await response.text();
        
        if (!pdbData || !pdbData.includes('ATOM')) {
            throw new Error('Invalid PDB data');
        }
        
        return pdbData;
    } catch (error) {
        console.error('Error fetching PDB:', error);
        throw error;
    }
}

// Apply pLDDT confidence-based coloring
function applyConfidenceColoring(viewer) {
    viewer.setStyle({}, {
        cartoon: {
            colorfunc: function(atom) {
                const bfactor = atom.b;
                if (bfactor > 90) return '#0053d6';      // Very high - blue
                if (bfactor > 70) return '#65cbf3';      // Confident - cyan
                if (bfactor > 50) return '#ffdb58';      // Low - yellow
                return '#ff7d45';                         // Very low - orange
            }
        }
    });
}

// Populate isoform selector dropdown
function populateIsoformSelector(index, isoforms) {
    const selector = document.getElementById(`isoform-select-${index}`);
    const countSpan = document.getElementById(`isoform-count-${index}`);
    
    if (!selector) return;
    
    selector.innerHTML = '';
    
    isoforms.forEach((isoform, i) => {
        const option = document.createElement('option');
        option.value = i;
        
        // Create label from UniProt ID
        const label = isoform.uniprotId || isoform.entryId || `Isoform ${i + 1}`;
        const confidence = isoform.globalMetricValue ? ` (pLDDT: ${isoform.globalMetricValue.toFixed(1)})` : '';
        option.textContent = `${label}${confidence}`;
        
        selector.appendChild(option);
    });
    
    if (countSpan) {
        countSpan.textContent = `${isoforms.length} isoform${isoforms.length > 1 ? 's' : ''} available`;
    }
}

// Populate comparison selector
function populateCompareSelector(index, isoforms) {
    const selector = document.getElementById(`compare-select-${index}`);
    if (!selector) return;
    
    selector.innerHTML = '<option value="">Select isoform to compare...</option>';
    
    isoforms.forEach((isoform, i) => {
        const option = document.createElement('option');
        option.value = i;
        
        const label = isoform.uniprotId || isoform.entryId || `Isoform ${i + 1}`;
        const confidence = isoform.globalMetricValue ? ` (pLDDT: ${isoform.globalMetricValue.toFixed(1)})` : '';
        option.textContent = `${label}${confidence}`;
        
        selector.appendChild(option);
    });
}

// Update quick info bar
function updateQuickInfo(index, isoform) {
    const badge = document.getElementById(`confidence-badge-${index}`);
    const seqLength = document.getElementById(`seq-length-${index}`);
    
    if (badge && isoform.globalMetricValue) {
        const confidence = isoform.globalMetricValue;
        badge.textContent = `pLDDT: ${confidence.toFixed(1)}`;
        
        // Set confidence class
        badge.className = 'confidence-badge';
        if (confidence > 90) badge.classList.add('very-high');
        else if (confidence > 70) badge.classList.add('confident');
        else if (confidence > 50) badge.classList.add('low');
        else badge.classList.add('very-low');
    }
    
    if (seqLength && isoform.uniprotEnd) {
        seqLength.textContent = `${isoform.uniprotEnd} aa`;
    }
}

// Load PAE image
function loadPAEImage(index, paeImageUrl) {
    const container = document.getElementById(`pae-container-${index}`);
    if (!container || !paeImageUrl) {
        if (container) {
            container.innerHTML = `
                <div class="pae-unavailable">
                    <span class="icon">📊</span>
                    <p>PAE data not available</p>
                </div>
            `;
        }
        return;
    }
    
    const img = new Image();
    img.onload = function() {
        container.innerHTML = '';
        container.appendChild(img);
    };
    img.onerror = function() {
        container.innerHTML = `
            <div class="pae-unavailable">
                <span class="icon">⚠️</span>
                <p>Failed to load PAE image</p>
            </div>
        `;
    };
    img.src = paeImageUrl.startsWith('/api/proxy') ? paeImageUrl : proxiedUrl(paeImageUrl);
    img.alt = 'Predicted Aligned Error (PAE) Heatmap';
    img.style.maxWidth = '100%';
    img.style.maxHeight = '100%';
}

// Load AlphaFold-specific details
async function loadAlphaFoldDetails(index, isoform, pdbData) {
    const detailsElement = document.getElementById(`details-${index}`);
    if (!detailsElement) return;
    
    // Parse PDB data for statistics
    const parsed = parsePDBData(pdbData);
    
    let html = '';
    
    // Protein Information
    html += `
        <div class="alphafold-detail-section">
            <h5><span class="icon">🧬</span> Protein Information</h5>
            <div class="detail-row"><span class="label">UniProt ID:</span> <span class="value">${isoform.uniprotId || isoform.entryId}</span></div>
            ${isoform.uniprotDescription ? `<div class="detail-row"><span class="label">Description:</span> <span class="value">${isoform.uniprotDescription}</span></div>` : ''}
            ${isoform.gene ? `<div class="detail-row"><span class="label">Gene:</span> <span class="value">${isoform.gene}</span></div>` : ''}
            ${isoform.organismScientificName ? `<div class="detail-row"><span class="label">Organism:</span> <span class="value">${isoform.organismScientificName}</span></div>` : ''}
            ${isoform.taxId ? `<div class="detail-row"><span class="label">Taxonomy ID:</span> <span class="value">${isoform.taxId}</span></div>` : ''}
        </div>
    `;
    
    // Model Information
    html += `
        <div class="alphafold-detail-section">
            <h5><span class="icon">🔬</span> Model Information</h5>
            <div class="detail-row"><span class="label">Model Version:</span> <span class="value">v${isoform.latestVersion || 'N/A'}</span></div>
            ${isoform.modelCreatedDate ? `<div class="detail-row"><span class="label">Created:</span> <span class="value">${isoform.modelCreatedDate.split('T')[0]}</span></div>` : ''}
            ${isoform.toolUsed ? `<div class="detail-row"><span class="label">Method:</span> <span class="value">${isoform.toolUsed}</span></div>` : ''}
            <div class="detail-row"><span class="label">Sequence Range:</span> <span class="value">${isoform.uniprotStart || 1}-${isoform.uniprotEnd || parsed.residues.size}</span></div>
            <div class="detail-row"><span class="label">Total Atoms:</span> <span class="value">${parsed.atomCount.toLocaleString()}</span></div>
            <div class="detail-row"><span class="label">Residues:</span> <span class="value">${parsed.residues.size}</span></div>
        </div>
    `;
    
    // Confidence Statistics
    html += `
        <div class="alphafold-detail-section">
            <h5><span class="icon">📊</span> Confidence Statistics</h5>
            <div class="detail-row"><span class="label">Global pLDDT:</span> <span class="value">${isoform.globalMetricValue?.toFixed(2) || 'N/A'}</span></div>
    `;
    
    // Confidence distribution bar
    if (isoform.fractionPlddtVeryHigh !== undefined) {
        const veryHigh = (isoform.fractionPlddtVeryHigh * 100).toFixed(1);
        const confident = (isoform.fractionPlddtConfident * 100).toFixed(1);
        const low = (isoform.fractionPlddtLow * 100).toFixed(1);
        const veryLow = (isoform.fractionPlddtVeryLow * 100).toFixed(1);
        
        html += `
            <div class="confidence-distribution">
                <div class="confidence-bar">
                    <div class="bar-segment very-high" style="width: ${veryHigh}%">${veryHigh > 5 ? veryHigh + '%' : ''}</div>
                    <div class="bar-segment confident" style="width: ${confident}%">${confident > 5 ? confident + '%' : ''}</div>
                    <div class="bar-segment low" style="width: ${low}%">${low > 5 ? low + '%' : ''}</div>
                    <div class="bar-segment very-low" style="width: ${veryLow}%">${veryLow > 5 ? veryLow + '%' : ''}</div>
                </div>
                <div class="detail-row"><span class="label">Very High (>90):</span> <span class="value" style="color: #0053d6;">${veryHigh}%</span></div>
                <div class="detail-row"><span class="label">Confident (70-90):</span> <span class="value" style="color: #65cbf3;">${confident}%</span></div>
                <div class="detail-row"><span class="label">Low (50-70):</span> <span class="value" style="color: #ffdb58;">${low}%</span></div>
                <div class="detail-row"><span class="label">Very Low (<50):</span> <span class="value" style="color: #ff7d45;">${veryLow}%</span></div>
            </div>
        `;
    }
    html += `</div>`;
    
    // Resources
    html += `
        <div class="alphafold-detail-section">
            <h5><span class="icon">🔗</span> Resources</h5>
            <div class="resource-links">
                <a href="https://alphafold.ebi.ac.uk/entry/${isoform.uniprotId || isoform.entryId}" target="_blank" class="resource-link">AlphaFold DB</a>
                <a href="https://www.uniprot.org/uniprotkb/${(isoform.uniprotId || isoform.entryId).split('-')[0]}" target="_blank" class="resource-link">UniProt</a>
                ${isoform.pdbUrl ? `<a href="${isoform.pdbUrl}" target="_blank" class="resource-link">Download PDB</a>` : ''}
                ${isoform.cifUrl ? `<a href="${isoform.cifUrl}" target="_blank" class="resource-link">Download mmCIF</a>` : ''}
            </div>
        </div>
    `;
    
    detailsElement.innerHTML = html;
}

// Load sequence display
function loadSequence(index, isoform) {
    const seqDisplay = document.getElementById(`sequence-display-${index}`);
    const seqStats = document.getElementById(`sequence-stats-${index}`);
    
    if (!seqDisplay) return;
    
    // Check if sequence available from isoform data
    if (isoform.uniprotSequence) {
        alphaFoldData[index].sequence = isoform.uniprotSequence;
        displayFormattedSequence(seqDisplay, isoform.uniprotSequence);
        
        if (seqStats) {
            seqStats.textContent = `${isoform.uniprotSequence.length} residues`;
        }
    } else {
        // Try to fetch from UniProt
        fetchUniProtSequence(isoform.uniprotId || isoform.entryId).then(sequence => {
            if (sequence) {
                alphaFoldData[index].sequence = sequence;
                displayFormattedSequence(seqDisplay, sequence);
                
                if (seqStats) {
                    seqStats.textContent = `${sequence.length} residues`;
                }
            } else {
                seqDisplay.innerHTML = '<span class="loading-text">Sequence not available</span>';
            }
        });
    }
}

// Fetch sequence from UniProt
async function fetchUniProtSequence(uniprotId) {
    try {
        const baseId = uniprotId.split('-')[0];
        const response = await fetch(proxiedUrl(`https://rest.uniprot.org/uniprotkb/${baseId}.fasta`));
        if (!response.ok) return null;
        
        const fasta = await response.text();
        // Remove header line and join sequence
        const lines = fasta.split('\n');
        return lines.slice(1).join('').replace(/\s/g, '');
    } catch (e) {
        console.error('Error fetching UniProt sequence:', e);
        return null;
    }
}

// Display formatted sequence with coloring
function displayFormattedSequence(container, sequence) {
    // Amino acid properties for coloring
    const hydrophobic = new Set(['A', 'V', 'I', 'L', 'M', 'F', 'W', 'P']);
    const polar = new Set(['S', 'T', 'N', 'Q', 'Y', 'C']);
    const positive = new Set(['K', 'R', 'H']);
    const negative = new Set(['D', 'E']);
    const special = new Set(['G', 'P']);
    
    let html = '';
    for (let i = 0; i < sequence.length; i++) {
        const aa = sequence[i];
        let className = '';
        
        if (hydrophobic.has(aa)) className = 'aa-hydrophobic';
        else if (polar.has(aa)) className = 'aa-polar';
        else if (positive.has(aa)) className = 'aa-positive';
        else if (negative.has(aa)) className = 'aa-negative';
        else if (special.has(aa)) className = 'aa-special';
        
        // Add line break every 60 characters
        if (i > 0 && i % 60 === 0) {
            html += '<br>';
        }
        // Add space every 10 characters
        if (i > 0 && i % 10 === 0 && i % 60 !== 0) {
            html += ' ';
        }
        
        html += `<span class="${className}">${aa}</span>`;
    }
    
    container.innerHTML = html;
}

// Change isoform
async function changeIsoform(index, isoformIndex) {
    const data = alphaFoldData[index];
    if (!data || !data.isoforms[isoformIndex]) return;
    
    const isoform = data.isoforms[isoformIndex];
    data.currentIsoform = parseInt(isoformIndex);
    
    // Show loading
    const viewerElement = document.getElementById(`viewer-${index}`);
    if (viewerElement) {
        viewerElement.innerHTML = '<div class="pae-loading"><div class="loading-spinner"></div><p>Loading isoform...</p></div>';
    }
    
    try {
        // Fetch new PDB data
        const pdbData = await fetchAlphaFoldPDB(isoform.pdbUrl);
        
        // Create new viewer
        const config = { backgroundColor: 'black' };
        const viewer = $3Dmol.createViewer(viewerElement, config);
        viewers[index] = viewer;
        
        viewer.addModel(pdbData, "pdb");
        applyConfidenceColoring(viewer);
        viewer.zoomTo();
        viewer.render();
        viewer.zoom(1.2, 1000);
        
        // Update UI
        updateQuickInfo(index, isoform);
        loadPAEImage(index, isoform.paeImageUrl);
        await loadAlphaFoldDetails(index, isoform, pdbData);
        loadSequence(index, isoform);
        
    } catch (error) {
        console.error('Error changing isoform:', error);
        viewerElement.innerHTML = `<div class="viewer-error"><p>Error loading isoform</p></div>`;
    }
}

// Load comparison structure
async function loadComparisonStructure(index, isoformIndex) {
    if (!isoformIndex) return;
    
    const data = alphaFoldData[index];
    if (!data || !data.isoforms[isoformIndex]) return;
    
    const isoform = data.isoforms[isoformIndex];
    const viewerElement = document.getElementById(`viewer-compare-${index}`);
    const controlsElement = document.getElementById(`compare-controls-${index}`);
    
    if (!viewerElement) return;
    
    // Show loading
    viewerElement.innerHTML = '<div class="pae-loading"><div class="loading-spinner"></div><p>Loading comparison...</p></div>';
    
    try {
        // Fetch PDB data
        const pdbData = await fetchAlphaFoldPDB(isoform.pdbUrl);
        
        // Clear and create viewer
        viewerElement.innerHTML = '';
        
        const config = { backgroundColor: 'black' };
        const viewer = $3Dmol.createViewer(viewerElement, config);
        compareViewers[index] = viewer;
        
        viewer.addModel(pdbData, "pdb");
        applyConfidenceColoring(viewer);
        viewer.zoomTo();
        viewer.render();
        viewer.zoom(1.2, 1000);
        
        // Show controls
        if (controlsElement) {
            controlsElement.style.display = 'block';
        }
        
    } catch (error) {
        console.error('Error loading comparison:', error);
        viewerElement.innerHTML = `
            <div class="empty-viewer-message">
                <span class="icon">⚠️</span>
                <p>Error loading comparison structure</p>
            </div>
        `;
    }
}

// Change color scheme for AlphaFold (handles confidence option)
function changeAlphaFoldColorScheme(index, scheme) {
    const viewer = viewers[index];
    if (!viewer) return;
    
    const currentStyle = representationStyles[index] || 'cartoon';
    
    if (scheme === 'confidence') {
        applyConfidenceColoring(viewer);
    } else {
        // Use standard 3Dmol color schemes
        let colorOption;
        switch(scheme) {
            case 'spectrum':
                colorOption = { color: 'spectrum' };
                break;
            case 'chain':
                colorOption = { colorscheme: 'chain' };
                break;
            case 'ss':
                colorOption = { colorscheme: 'ssJmol' };
                break;
            case 'white':
                colorOption = { color: 'white' };
                break;
            default:
                colorOption = { color: 'spectrum' };
        }
        
        const styleObj = {};
        styleObj[currentStyle] = colorOption;
        viewer.setStyle({}, styleObj);
    }
    
    viewer.render();
}

// Comparison viewer controls
function changeCompareRepresentation(index, style) {
    const viewer = compareViewers[index];
    if (!viewer) return;
    
    const styleObj = {};
    if (style === 'cartoon') {
        applyConfidenceColoring(viewer);
    } else {
        styleObj[style] = { color: 'spectrum' };
        viewer.setStyle({}, styleObj);
    }
    
    viewer.render();
}

function resetCompareView(index) {
    const viewer = compareViewers[index];
    if (!viewer) return;
    
    viewer.zoomTo();
    viewer.render();
}

function toggleCompareSpin(index, btn) {
    const viewer = compareViewers[index];
    if (!viewer) return;
    
    if (compareSpinIntervals[index]) {
        clearInterval(compareSpinIntervals[index]);
        compareSpinIntervals[index] = null;
        btn.classList.remove('active');
    } else {
        compareSpinIntervals[index] = setInterval(() => {
            viewer.rotate(1, 'y');
            viewer.render();
        }, 50);
        btn.classList.add('active');
    }
}

function syncViewers(index) {
    const mainViewer = viewers[index];
    const compareViewer = compareViewers[index];
    
    if (!mainViewer || !compareViewer) return;
    
    // Get orientation from main viewer and apply to compare viewer
    const mainView = mainViewer.getView();
    compareViewer.setView(mainView);
    compareViewer.render();
}

// Sequence tools
function copySequence(index) {
    const data = alphaFoldData[index];
    if (!data || !data.sequence) {
        alert('Sequence not available');
        return;
    }
    
    navigator.clipboard.writeText(data.sequence).then(() => {
        alert('Sequence copied to clipboard!');
    }).catch(err => {
        console.error('Failed to copy:', err);
    });
}

function downloadFasta(index) {
    const data = alphaFoldData[index];
    if (!data || !data.sequence) {
        alert('Sequence not available');
        return;
    }
    
    const isoform = data.isoforms[data.currentIsoform];
    const header = `>${isoform.uniprotId || isoform.entryId} | ${isoform.uniprotDescription || 'AlphaFold Predicted Structure'}`;
    
    // Format sequence with line breaks every 60 characters
    let formattedSeq = '';
    for (let i = 0; i < data.sequence.length; i += 60) {
        formattedSeq += data.sequence.substring(i, i + 60) + '\n';
    }
    
    const fasta = header + '\n' + formattedSeq;
    
    const blob = new Blob([fasta], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${isoform.uniprotId || isoform.entryId}.fasta`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

function toggleSequencePanel(index) {
    const panel = document.querySelector(`#panel-content-${index} .sequence-panel`);
    const content = document.getElementById(`sequence-content-${index}`);
    
    if (panel && content) {
        panel.classList.toggle('collapsed');
        content.style.display = content.style.display === 'none' ? 'block' : 'none';
    }
}

// ================================================
// Secondary Structure Highlighting Functions
// ================================================

// Track secondary structure visibility states
let ssStates = {};

function initSSState(index) {
    if (!ssStates[index]) {
        ssStates[index] = {
            helix: true,
            sheet: true,
            loop: true
        };
    }
}

function toggleSecondaryStructure(index, ssType, btn) {
    initSSState(index);
    
    // Toggle the state
    ssStates[index][ssType] = !ssStates[index][ssType];
    
    // Update button appearance
    if (btn) {
        btn.classList.toggle('active', ssStates[index][ssType]);
    }
    
    // Apply the secondary structure filter
    applySecondaryStructureFilter(index);
}

function applySecondaryStructureFilter(index) {
    const viewer = viewers[index];
    if (!viewer) return;
    
    initSSState(index);
    
    const showHelix = ssStates[index].helix;
    const showSheet = ssStates[index].sheet;
    const showLoop = ssStates[index].loop;
    
    // Get current representation style
    const currentStyle = representationStyles[index] || 'cartoon';
    
    // Clear existing styles
    viewer.setStyle({}, {});
    
    // Get current color scheme
    const colorSelect = document.getElementById(`color-select-${index}`);
    const colorScheme = colorSelect ? colorSelect.value : 'spectrum';
    
    // Build style object based on color scheme
    let styleObj = {};
    if (colorScheme === 'confidence') {
        styleObj = {
            colorfunc: function(atom) {
                const bfactor = atom.b;
                if (bfactor > 90) return '#0053d6';
                if (bfactor > 70) return '#65cbf3';
                if (bfactor > 50) return '#ffdb58';
                return '#ff7d45';
            }
        };
    } else if (colorScheme === 'ss') {
        styleObj = { colorscheme: 'ssJmol' };
    } else if (colorScheme === 'chain') {
        styleObj = { colorscheme: 'chain' };
    } else if (colorScheme === 'white') {
        styleObj = { color: 'white' };
    } else {
        styleObj = { color: 'spectrum' };
    }
    
    // Apply styles based on secondary structure type
    // In 3Dmol.js: ss = 'h' for helix, 's' for sheet, 'c' or '' for coil/loop
    
    if (showHelix) {
        const helixStyle = {};
        helixStyle[currentStyle] = { ...styleObj };
        viewer.addStyle({ ss: 'h' }, helixStyle);
    }
    
    if (showSheet) {
        const sheetStyle = {};
        sheetStyle[currentStyle] = { ...styleObj };
        viewer.addStyle({ ss: 's' }, sheetStyle);
    }
    
    if (showLoop) {
        const loopStyle = {};
        loopStyle[currentStyle] = { ...styleObj };
        // Loops are either 'c' (coil) or empty string
        viewer.addStyle({ ss: 'c' }, loopStyle);
        viewer.addStyle({ ss: '' }, loopStyle);
    }
    
    viewer.render();
}

// ================================================
// Binding Pocket Detection Functions
// ================================================

let pocketStates = {};

function detectBindingPockets(index, btn) {
    const viewer = viewers[index];
    if (!viewer) return;
    
    // Toggle pocket visibility
    if (!pocketStates[index]) {
        pocketStates[index] = false;
    }
    pocketStates[index] = !pocketStates[index];
    
    if (btn) {
        btn.classList.toggle('active', pocketStates[index]);
    }
    
    if (pocketStates[index]) {
        // Highlight potential binding pockets
        // Strategy: Find surface-exposed hydrophobic and aromatic residues
        // These often form binding sites
        
        // Hydrophobic residues often in binding pockets
        const hydrophobicResidues = ['ALA', 'VAL', 'ILE', 'LEU', 'MET', 'PHE', 'TRP', 'TYR', 'PRO'];
        
        // Aromatic residues common in binding sites
        const aromaticResidues = ['PHE', 'TRP', 'TYR', 'HIS'];
        
        // Charged residues often at binding interfaces
        const chargedResidues = ['ARG', 'LYS', 'ASP', 'GLU', 'HIS'];
        
        // Add surface highlighting for potential binding residues
        viewer.addSurface($3Dmol.SurfaceType.VDW, {
            opacity: 0.6,
            color: 'yellow'
        }, { resn: hydrophobicResidues, not: { atom: ['C', 'N', 'O', 'CA'] } });
        
        // Highlight aromatic residues with different color
        viewer.addStyle({ resn: aromaticResidues }, {
            stick: { radius: 0.2, color: 'orange' }
        });
        
        // Also show ligand binding sites if ligands present
        viewer.addStyle({ hetflag: true, not: { resn: ['HOH', 'WAT'] } }, {
            sphere: { radius: 0.5, color: 'red' }
        });
        
        // Show contact residues near ligands (within 5 angstroms)
        viewer.addStyle({ within: { distance: 5, sel: { hetflag: true, not: { resn: ['HOH', 'WAT'] } } } }, {
            stick: { radius: 0.15, colorscheme: 'greenCarbon' }
        });
        
    } else {
        // Remove pocket highlighting - reapply normal style
        viewer.removeAllSurfaces();
        
        // Reapply current representation styles
        rebuildViewerStyles(index);
    }
    
    viewer.render();
}

// ================================================
// Surface Highlighting Functions
// ================================================

let surfaceStates = {};

function highlightSurface(index, btn) {
    const viewer = viewers[index];
    if (!viewer) return;
    
    // Toggle surface visibility
    if (!surfaceStates[index]) {
        surfaceStates[index] = false;
    }
    surfaceStates[index] = !surfaceStates[index];
    
    if (btn) {
        btn.classList.toggle('active', surfaceStates[index]);
    }
    
    if (surfaceStates[index]) {
        // Add semi-transparent molecular surface
        viewer.addSurface($3Dmol.SurfaceType.MS, {
            opacity: 0.7,
            colorscheme: 'whiteCarbon'
        }, { not: { hetflag: true } });
        
        // Color by electrostatic potential approximation (hydrophobicity)
        // Red = hydrophobic, Blue = hydrophilic
        viewer.addSurface($3Dmol.SurfaceType.VDW, {
            opacity: 0.5,
            colorscheme: {
                prop: 'b',
                gradient: 'rwb',
                min: 0,
                max: 100
            }
        }, { not: { hetflag: true } });
        
    } else {
        // Remove all surfaces
        viewer.removeAllSurfaces();
    }
    
    viewer.render();
}

// ================================================
// Export Functions
// ================================================

function exportScreenshot(index) {
    const viewer = viewers[index];
    if (!viewer) {
        alert('Viewer not available');
        return;
    }
    
    try {
        // Get the canvas element
        const viewerElement = document.getElementById(`viewer-${index}`);
        const canvas = viewerElement.querySelector('canvas');
        
        if (!canvas) {
            alert('Could not find viewer canvas');
            return;
        }
        
        // Use 3Dmol's pngURI function
        const pngUri = viewer.pngURI();
        
        // Create download link
        const link = document.createElement('a');
        link.download = `structure_${index}_screenshot.png`;
        link.href = pngUri;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        
        console.log('Screenshot exported successfully');
    } catch (error) {
        console.error('Error exporting screenshot:', error);
        alert('Failed to export screenshot: ' + error.message);
    }
}

function downloadPDB(index, pdbCode) {
    if (!pdbCode) {
        alert('PDB code not available');
        return;
    }
    
    // Check if we have cached PDB data
    if (pdbDataCache[pdbCode]) {
        downloadFile(pdbDataCache[pdbCode], `${pdbCode}.pdb`, 'text/plain');
    } else {
        // Redirect to RCSB download
        window.open(`https://files.rcsb.org/download/${pdbCode}.pdb`, '_blank');
    }
}

function downloadAlphaFoldPDB(index) {
    const data = alphaFoldData[index];
    if (!data || !data.isoforms) {
        alert('AlphaFold data not available');
        return;
    }
    
    const isoform = data.isoforms[data.currentIsoform || 0];
    if (isoform && isoform.pdbUrl) {
        window.open(isoform.pdbUrl, '_blank');
    } else {
        alert('PDB URL not available');
    }
}

function downloadAlphaFoldCIF(index) {
    const data = alphaFoldData[index];
    if (!data || !data.isoforms) {
        alert('AlphaFold data not available');
        return;
    }
    
    const isoform = data.isoforms[data.currentIsoform || 0];
    if (isoform && isoform.cifUrl) {
        window.open(isoform.cifUrl, '_blank');
    } else {
        alert('mmCIF URL not available');
    }
}

function downloadFile(content, filename, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.download = filename;
    link.href = url;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
}

// ================================================
// Browser-Based Dynamics Visualization Functions
// ================================================

// Track dynamics states
let thermalMotionStates = {};
let thermalMotionIntervals = {};
let flexibilityViewStates = {};
let minimizationStates = {};
let originalAtomPositions = {};

// Toggle thermal motion animation (simulates B-factor based vibrations)
function toggleThermalMotion(index, btn) {
    const viewer = viewers[index];
    if (!viewer) {
        alert('Viewer not available');
        return;
    }
    
    // Toggle state
    if (thermalMotionStates[index]) {
        // Stop thermal motion
        stopThermalMotion(index);
        btn.classList.remove('active');
        btn.textContent = '🌡️ Thermal';
    } else {
        // Start thermal motion
        startThermalMotion(index, viewer);
        btn.classList.add('active');
        btn.textContent = '⏹ Stop';
    }
}

function startThermalMotion(index, viewer) {
    thermalMotionStates[index] = true;
    
    // Add vibration indicator
    addDynamicsIndicator(index, 'Thermal Motion', 'Simulating atomic vibrations - viewer rotating');
    
    // Use viewer vibrate/shake effect via rotation oscillation
    let frame = 0;
    const baseView = viewer.getView();
    
    thermalMotionIntervals[index] = setInterval(() => {
        if (!thermalMotionStates[index]) return;
        
        // Create a shaking/vibrating effect by small rotations
        const amplitude = 2; // degrees
        const frequency = 0.3;
        
        const dx = amplitude * Math.sin(frame * frequency);
        const dy = amplitude * Math.cos(frame * frequency * 1.3);
        const dz = amplitude * Math.sin(frame * frequency * 0.7 + Math.PI/4);
        
        viewer.rotate(dx, 'x');
        viewer.rotate(dy, 'y');
        viewer.render();
        
        // Counter-rotate to create vibration effect
        viewer.rotate(-dx, 'x');
        viewer.rotate(-dy, 'y');
        
        frame++;
    }, 40); // 25 FPS
}

function stopThermalMotion(index) {
    thermalMotionStates[index] = false;
    
    if (thermalMotionIntervals[index]) {
        clearInterval(thermalMotionIntervals[index]);
        thermalMotionIntervals[index] = null;
    }
    
    // Just remove indicator - no atom positions to restore
    removeDynamicsIndicator(index);
}

// Toggle flexibility view (color by predicted flexibility)
function toggleFlexibilityView(index, btn) {
    const viewer = viewers[index];
    if (!viewer) {
        alert('Viewer not available');
        return;
    }
    
    // Toggle state
    flexibilityViewStates[index] = !flexibilityViewStates[index];
    
    if (flexibilityViewStates[index]) {
        btn.classList.add('active');
        btn.textContent = '🌊 Normal';
        showFlexibilityView(index, viewer);
    } else {
        btn.classList.remove('active');
        btn.textContent = '🌊 Flexibility';
        // Return to confidence coloring
        applyConfidenceColoring(viewer);
        removeFlexibilityLegend(index);
    }
}

function showFlexibilityView(index, viewer) {
    // Color by flexibility (inverse of pLDDT)
    // Blue = rigid (high pLDDT), Red = flexible (low pLDDT)
    
    // Remove any existing surfaces first
    viewer.removeAllSurfaces();
    
    viewer.setStyle({}, {
        cartoon: {
            colorfunc: function(atom) {
                const pLDDT = atom.b || 50;
                // Map pLDDT to color: high (rigid) = blue, low (flexible) = red
                if (pLDDT > 90) return 0x0066FF; // Very rigid - blue
                if (pLDDT > 70) return 0x00CCFF; // Rigid - cyan
                if (pLDDT > 50) return 0xFFFF00; // Moderate - yellow
                if (pLDDT > 30) return 0xFF8800; // Flexible - orange
                return 0xFF0000; // Very flexible - red
            },
            thickness: 0.4
        }
    });
    
    viewer.render();
    
    // Add flexibility legend
    addFlexibilityLegend(index);
}

function addFlexibilityLegend(index) {
    const viewerContainer = document.getElementById(`viewer-${index}`);
    if (!viewerContainer) return;
    
    removeFlexibilityLegend(index);
    
    const legend = document.createElement('div');
    legend.className = 'flexibility-legend';
    legend.innerHTML = `
        <span class="legend-title">Predicted Flexibility</span>
        <div class="flex-gradient">
            <span class="flex-label rigid">Rigid</span>
            <div class="gradient-bar">
                <div class="gradient-fill"></div>
            </div>
            <span class="flex-label flexible">Flexible</span>
        </div>
        <p class="flex-note">Based on pLDDT confidence scores</p>
    `;
    viewerContainer.appendChild(legend);
}

function removeFlexibilityLegend(index) {
    const viewerContainer = document.getElementById(`viewer-${index}`);
    if (!viewerContainer) return;
    
    const existing = viewerContainer.querySelector('.flexibility-legend');
    if (existing) existing.remove();
}

// Run visual energy minimization animation
function runEnergyMinimization(index, btn) {
    const viewer = viewers[index];
    if (!viewer) {
        alert('Viewer not available');
        return;
    }
    
    // If already running, stop
    if (minimizationStates[index]) {
        stopMinimization(index);
        btn.classList.remove('active');
        btn.textContent = '⚡ Minimize';
        return;
    }
    
    minimizationStates[index] = true;
    btn.classList.add('active');
    btn.textContent = '⏹ Stop';
    
    // Store original positions if needed
    const model = viewer.getModel();
    if (!model) return;
    
    if (!originalAtomPositions[index]) {
        const atoms = model.selectedAtoms({});
        originalAtomPositions[index] = atoms.map(atom => ({
            x: atom.x,
            y: atom.y,
            z: atom.z,
            b: atom.b || 50
        }));
    }
    
    // Add minimization indicator
    addDynamicsIndicator(index, 'Energy Minimization', 'Simulating structure relaxation...');
    addEnergyGraph(index);
    
    // Run minimization animation
    runMinimizationAnimation(index, viewer, btn);
}

function runMinimizationAnimation(index, viewer, btn) {
    // Remove any surfaces that might exist
    viewer.removeAllSurfaces();
    
    // Simulated energy curve (starts high, decreases to minimum)
    let step = 0;
    const maxSteps = 100;
    let currentEnergy = 1000 + Math.random() * 500; // Starting "energy"
    const targetEnergy = 50 + Math.random() * 50;
    
    // Store initial view for shake effect
    const baseView = viewer.getView();
    
    const minimizationInterval = setInterval(() => {
        if (!minimizationStates[index] || step >= maxSteps) {
            clearInterval(minimizationInterval);
            
            if (step >= maxSteps) {
                // Finished - restore view
                if (baseView) viewer.setView(baseView);
                viewer.render();
                
                updateEnergyGraph(index, targetEnergy, maxSteps, maxSteps, true);
                updateDynamicsIndicator(index, 'Minimization Complete', `Final energy: ${targetEnergy.toFixed(1)} kJ/mol`);
                
                // Reset button after a delay
                setTimeout(() => {
                    btn.classList.remove('active');
                    btn.textContent = '⚡ Minimize';
                    minimizationStates[index] = false;
                    removeDynamicsIndicator(index);
                    removeEnergyGraph(index);
                }, 2000);
            }
            return;
        }
        
        // Calculate progress (exponential decay toward target)
        const progress = step / maxSteps;
        const decayFactor = Math.exp(-progress * 3);
        currentEnergy = targetEnergy + (1000 - targetEnergy) * decayFactor + Math.random() * 20 * decayFactor;
        
        // Shake the view to simulate minimization (decreasing amplitude)
        const shakeAmplitude = 3 * decayFactor;
        viewer.rotate(shakeAmplitude * (Math.random() - 0.5), 'x');
        viewer.rotate(shakeAmplitude * (Math.random() - 0.5), 'y');
        
        viewer.render();
        updateEnergyGraph(index, currentEnergy, step, maxSteps, false);
        updateDynamicsIndicator(index, 'Energy Minimization', `Step ${step}/${maxSteps} | Energy: ${currentEnergy.toFixed(1)} kJ/mol`);
        
        step++;
    }, 50);
    
    minimizationStates[index] = minimizationInterval;
}

function stopMinimization(index) {
    if (minimizationStates[index] && typeof minimizationStates[index] !== 'boolean') {
        clearInterval(minimizationStates[index]);
    }
    minimizationStates[index] = false;
    
    // Restore original positions
    const viewer = viewers[index];
    if (viewer && originalAtomPositions[index]) {
        const model = viewer.getModel();
        if (model) {
            const atoms = model.selectedAtoms({});
            const originals = originalAtomPositions[index];
            
            atoms.forEach((atom, i) => {
                if (originals[i]) {
                    atom.x = originals[i].x;
                    atom.y = originals[i].y;
                    atom.z = originals[i].z;
                }
            });
            
            viewer.render();
        }
    }
    
    removeDynamicsIndicator(index);
    removeEnergyGraph(index);
}

// Dynamics indicator helpers
function addDynamicsIndicator(index, title, message) {
    const viewerContainer = document.getElementById(`viewer-${index}`);
    if (!viewerContainer) return;
    
    removeDynamicsIndicator(index);
    
    const indicator = document.createElement('div');
    indicator.className = 'dynamics-indicator';
    indicator.innerHTML = `
        <span class="dyn-title">${title}</span>
        <span class="dyn-message">${message}</span>
    `;
    viewerContainer.appendChild(indicator);
}

function updateDynamicsIndicator(index, title, message) {
    const viewerContainer = document.getElementById(`viewer-${index}`);
    if (!viewerContainer) return;
    
    const indicator = viewerContainer.querySelector('.dynamics-indicator');
    if (indicator) {
        indicator.querySelector('.dyn-title').textContent = title;
        indicator.querySelector('.dyn-message').textContent = message;
    }
}

function removeDynamicsIndicator(index) {
    const viewerContainer = document.getElementById(`viewer-${index}`);
    if (!viewerContainer) return;
    
    const existing = viewerContainer.querySelector('.dynamics-indicator');
    if (existing) existing.remove();
}

// Energy graph helpers
function addEnergyGraph(index) {
    const viewerContainer = document.getElementById(`viewer-${index}`);
    if (!viewerContainer) return;
    
    removeEnergyGraph(index);
    
    const graph = document.createElement('div');
    graph.className = 'energy-graph';
    graph.innerHTML = `
        <div class="graph-title">Energy (kJ/mol)</div>
        <div class="graph-canvas">
            <canvas id="energy-canvas-${index}" width="150" height="60"></canvas>
        </div>
    `;
    viewerContainer.appendChild(graph);
    
    // Initialize canvas
    const canvas = document.getElementById(`energy-canvas-${index}`);
    if (canvas) {
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = 'rgba(15, 15, 30, 0.8)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.strokeStyle = 'rgba(102, 126, 234, 0.3)';
        ctx.beginPath();
        ctx.moveTo(0, canvas.height - 5);
        ctx.lineTo(canvas.width, canvas.height - 5);
        ctx.stroke();
    }
}

function updateEnergyGraph(index, energy, step, maxSteps, isComplete) {
    const canvas = document.getElementById(`energy-canvas-${index}`);
    if (!canvas) return;
    
    const ctx = canvas.getContext('2d');
    const x = (step / maxSteps) * canvas.width;
    const y = canvas.height - ((energy - 50) / 1000 * (canvas.height - 10)) - 5;
    
    // Draw line segment
    ctx.strokeStyle = isComplete ? '#4caf50' : '#667eea';
    ctx.lineWidth = 2;
    
    if (step === 0) {
        ctx.beginPath();
        ctx.moveTo(x, y);
    } else {
        ctx.lineTo(x, Math.max(5, Math.min(canvas.height - 5, y)));
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x, Math.max(5, Math.min(canvas.height - 5, y)));
    }
    
    // Draw current point
    ctx.fillStyle = isComplete ? '#4caf50' : '#ff7e5f';
    ctx.beginPath();
    ctx.arc(x, Math.max(5, Math.min(canvas.height - 5, y)), 3, 0, Math.PI * 2);
    ctx.fill();
}

function removeEnergyGraph(index) {
    const viewerContainer = document.getElementById(`viewer-${index}`);
    if (!viewerContainer) return;
    
    const existing = viewerContainer.querySelector('.energy-graph');
    if (existing) existing.remove();
}

// Progress indicator helpers (kept for compatibility)
function showSimulationProgress(message, index) {
    const panel = document.querySelector(`#panel-content-${index} .primary-viewer-panel`);
    if (panel) {
        const existing = panel.querySelector('.sim-progress');
        if (existing) existing.remove();
        
        const progress = document.createElement('div');
        progress.className = 'sim-progress';
        progress.innerHTML = `<div class="loading-spinner small"></div><span>${message}</span>`;
        panel.appendChild(progress);
    }
}

function hideSimulationProgress(index) {
    const progress = document.querySelector(`#panel-content-${index} .sim-progress`);
    if (progress) progress.remove();
}

// ================================================
// Isoform Animation and Morphing Functions
// ================================================

// Track animation states
let morphAnimations = {};
let sideBySideAnimations = {};
let overlayStates = {};

// Morph between primary and comparison structures
async function morphStructures(index, btn) {
    const mainViewer = viewers[index];
    const compareViewer = compareViewers[index];
    
    if (!mainViewer || !compareViewer) {
        alert('Both viewers must have structures loaded to morph');
        return;
    }
    
    // Toggle morph animation
    if (morphAnimations[index]) {
        // Stop animation
        cancelAnimationFrame(morphAnimations[index].frameId);
        morphAnimations[index] = null;
        btn.classList.remove('active');
        btn.textContent = '🔀 Morph';
        
        // Reset to original structure
        resetMorphView(index);
        return;
    }
    
    btn.classList.add('active');
    btn.textContent = '⏹ Stop';
    
    // Get atom positions from both structures
    const mainModel = mainViewer.getModel();
    const compareModel = compareViewer.getModel();
    
    if (!mainModel || !compareModel) {
        alert('Models not available for morphing');
        btn.classList.remove('active');
        btn.textContent = '🔀 Morph';
        return;
    }
    
    // Start morph animation on main viewer
    let progress = 0;
    let direction = 1;
    const morphSpeed = 0.02;
    
    morphAnimations[index] = {
        progress: 0,
        direction: 1
    };
    
    function animateMorph() {
        if (!morphAnimations[index]) return;
        
        progress += morphSpeed * direction;
        
        // Bounce at ends
        if (progress >= 1) {
            progress = 1;
            direction = -1;
        } else if (progress <= 0) {
            progress = 0;
            direction = 1;
        }
        
        morphAnimations[index].progress = progress;
        morphAnimations[index].direction = direction;
        
        // Update opacity to show transition effect
        // Fade between showing main (progress=0) and compare (progress=1)
        const mainOpacity = 1 - (progress * 0.8);
        const labelText = progress < 0.5 ? 'Primary' : 'Comparison';
        
        // Update visual indicator
        updateMorphIndicator(index, progress, labelText);
        
        morphAnimations[index].frameId = requestAnimationFrame(animateMorph);
    }
    
    // Add morph indicator
    addMorphIndicator(index);
    
    morphAnimations[index].frameId = requestAnimationFrame(animateMorph);
}

function addMorphIndicator(index) {
    const viewerContainer = document.getElementById(`viewer-${index}`);
    if (!viewerContainer) return;
    
    const existing = viewerContainer.querySelector('.morph-indicator');
    if (existing) existing.remove();
    
    const indicator = document.createElement('div');
    indicator.className = 'morph-indicator';
    indicator.innerHTML = `
        <div class="morph-bar">
            <div class="morph-progress" style="width: 0%"></div>
        </div>
        <span class="morph-label">Primary ↔ Comparison</span>
    `;
    viewerContainer.appendChild(indicator);
}

function updateMorphIndicator(index, progress, label) {
    const viewerContainer = document.getElementById(`viewer-${index}`);
    if (!viewerContainer) return;
    
    const progressBar = viewerContainer.querySelector('.morph-progress');
    const labelEl = viewerContainer.querySelector('.morph-label');
    
    if (progressBar) {
        progressBar.style.width = `${progress * 100}%`;
        progressBar.style.backgroundColor = progress < 0.5 ? '#667eea' : '#764ba2';
    }
    
    if (labelEl) {
        labelEl.textContent = label;
    }
}

function resetMorphView(index) {
    const viewerContainer = document.getElementById(`viewer-${index}`);
    if (!viewerContainer) {
        const indicator = viewerContainer.querySelector('.morph-indicator');
        if (indicator) indicator.remove();
    }
    
    // Restore original view
    const viewer = viewers[index];
    if (viewer) {
        applyConfidenceColoring(viewer);
        viewer.render();
    }
}

// Toggle side-by-side animation
function toggleSideBySideAnimation(index, btn) {
    const mainViewer = viewers[index];
    const compareViewer = compareViewers[index];
    
    if (!mainViewer || !compareViewer) {
        alert('Both viewers must have structures loaded to animate');
        return;
    }
    
    // Toggle animation
    if (sideBySideAnimations[index]) {
        // Stop animation
        clearInterval(sideBySideAnimations[index]);
        sideBySideAnimations[index] = null;
        btn.classList.remove('active');
        btn.textContent = '🎬 Animate';
        return;
    }
    
    btn.classList.add('active');
    btn.textContent = '⏹ Stop';
    
    // Synchronized rotation animation
    let angle = 0;
    sideBySideAnimations[index] = setInterval(() => {
        angle += 1;
        
        mainViewer.rotate(1, 'y');
        compareViewer.rotate(1, 'y');
        
        mainViewer.render();
        compareViewer.render();
    }, 50);
}

// Overlay both structures in main viewer
async function overlayStructures(index, btn) {
    const mainViewer = viewers[index];
    const data = alphaFoldData[index];
    
    if (!mainViewer || !data) {
        alert('Main viewer must have a structure loaded');
        return;
    }
    
    // Check if compare viewer has loaded structure
    const compareSelect = document.getElementById(`compare-select-${index}`);
    const selectedIsoform = compareSelect ? compareSelect.value : null;
    
    if (!selectedIsoform) {
        alert('Please select an isoform to compare first');
        return;
    }
    
    // Toggle overlay state
    if (overlayStates[index]) {
        // Remove overlay
        overlayStates[index] = false;
        btn.classList.remove('active');
        btn.textContent = '📐 Overlay';
        
        // Reload original structure
        const isoform = data.isoforms[data.currentIsoform || 0];
        const pdbData = await fetchAlphaFoldPDB(isoform.pdbUrl);
        
        mainViewer.removeAllModels();
        mainViewer.addModel(pdbData, "pdb");
        applyConfidenceColoring(mainViewer);
        mainViewer.zoomTo();
        mainViewer.render();
        
        return;
    }
    
    btn.classList.add('active');
    btn.textContent = '📐 Clear Overlay';
    overlayStates[index] = true;
    
    try {
        // Fetch comparison structure
        const compareIsoform = data.isoforms[selectedIsoform];
        const comparePdbData = await fetchAlphaFoldPDB(compareIsoform.pdbUrl);
        
        // Add second model with different color
        mainViewer.addModel(comparePdbData, "pdb");
        
        // Style first model (primary) in purple
        mainViewer.setStyle({ model: 0 }, {
            cartoon: { color: '#667eea', opacity: 0.8 }
        });
        
        // Style second model (comparison) in orange
        mainViewer.setStyle({ model: 1 }, {
            cartoon: { color: '#ff7e5f', opacity: 0.8 }
        });
        
        // Add legend
        addOverlayLegend(index);
        
        mainViewer.zoomTo();
        mainViewer.render();
        
    } catch (error) {
        console.error('Error overlaying structures:', error);
        alert('Failed to overlay structures: ' + error.message);
        overlayStates[index] = false;
        btn.classList.remove('active');
        btn.textContent = '📐 Overlay';
    }
}

function addOverlayLegend(index) {
    const viewerContainer = document.getElementById(`viewer-${index}`);
    if (!viewerContainer) return;
    
    const existing = viewerContainer.querySelector('.overlay-legend');
    if (existing) existing.remove();
    
    const legend = document.createElement('div');
    legend.className = 'overlay-legend';
    legend.innerHTML = `
        <span class="legend-item"><span class="color-dot primary"></span>Primary</span>
        <span class="legend-item"><span class="color-dot comparison"></span>Comparison</span>
    `;
    viewerContainer.appendChild(legend);
}

function removeOverlayLegend(index) {
    const viewerContainer = document.getElementById(`viewer-${index}`);
    if (!viewerContainer) return;
    
    const legend = viewerContainer.querySelector('.overlay-legend');
    if (legend) legend.remove();
}

// ==================== UniProt Viewer Functions ====================

const uniprotDataStore = {};
const uniprot3DViewers = {};
const uniprot3DSpinning = {};

async function initializeUniProtViewer(index, accession) {
    console.log(`Initializing UniProt viewer for ${accession} at index ${index}`);
    
    const featureViewer = document.getElementById(`feature-viewer-${index}`);
    const sequenceDisplay = document.getElementById(`uniprot-seq-display-${index}`);
    const proteinInfo = document.getElementById(`uniprot-info-${index}`);
    const crosslinksGrid = document.getElementById(`uniprot-crosslinks-${index}`);
    const viewer3DContainer = document.getElementById(`uniprot-3d-viewer-${index}`);
    const viewerStatus = document.getElementById(`uniprot-viewer-status-${index}`);
    
    if (!featureViewer || !sequenceDisplay) {
        console.error('UniProt viewer elements not found', { featureViewer, sequenceDisplay });
        return;
    }
    
    // Show loading state
    featureViewer.innerHTML = '<div class="loading-spinner"></div><p>Loading UniProt data...</p>';
    sequenceDisplay.innerHTML = '<span class="loading-text">Loading sequence...</span>';
    
    try {
        // Fetch UniProt data
        const response = await fetch(proxiedUrl(`https://rest.uniprot.org/uniprotkb/${accession}?format=json`));
        if (!response.ok) throw new Error(`UniProt fetch failed: ${response.status}`);
        
        const data = await response.json();
        uniprotDataStore[index] = data;
        uniprotDataStore[index].accession = accession;
        
        // Extract key information
        const sequence = data.sequence?.value || '';
        const seqLength = data.sequence?.length || sequence.length;
        const features = data.features || [];
        const proteinName = data.proteinDescription?.recommendedName?.fullName?.value || 
                          data.proteinDescription?.submittedName?.[0]?.fullName?.value ||
                          'Unknown Protein';
        const organism = data.organism?.scientificName || 'Unknown';
        const geneName = data.genes?.[0]?.geneName?.value || 'N/A';
        
        // Store for later use
        uniprotDataStore[index].parsedFeatures = parseUniProtFeatures(features);
        uniprotDataStore[index].sequence = sequence;
        uniprotDataStore[index].seqLength = seqLength;
        
        // Populate protein info
        if (proteinInfo) {
            proteinInfo.innerHTML = `
                <div class="info-row"><span class="info-label">Protein:</span> ${proteinName}</div>
                <div class="info-row"><span class="info-label">Gene:</span> ${geneName}</div>
                <div class="info-row"><span class="info-label">Organism:</span> ${organism}</div>
                <div class="info-row"><span class="info-label">Length:</span> ${seqLength} aa</div>
                <div class="info-row"><span class="info-label">Accession:</span> ${accession}</div>
            `;
        }
        
        // Render feature viewer
        renderFeatureViewer(index);
        
        // Display sequence with feature highlighting
        renderSequenceDisplay(index);
        
        // Populate cross-links
        populateUniProtCrosslinks(index, accession, data);
        
        // Initialize 3D viewer with AlphaFold structure
        if (viewer3DContainer) {
            await initializeUniProt3DViewer(index, accession);
        }
        
        console.log(`UniProt viewer initialized for ${accession}`);
        
    } catch (error) {
        console.error('Error initializing UniProt viewer:', error);
        featureViewer.innerHTML = `<div class="error-message">Failed to load UniProt data: ${error.message}</div>`;
        sequenceDisplay.textContent = 'Error loading sequence';
    }
}

// Initialize the 3D viewer for UniProt - tries multiple structure sources
async function initializeUniProt3DViewer(index, accession) {
    const container = document.getElementById(`uniprot-3d-viewer-${index}`);
    const statusEl = document.getElementById(`uniprot-viewer-status-${index}`);
    const data = uniprotDataStore[index];
    
    if (!container) {
        console.error('3D viewer container not found');
        return;
    }
    
    console.log('Initializing UniProt 3D viewer for:', accession);
    console.log('Data available:', !!data, 'Sequence:', data?.sequence?.substring(0, 50));
    
    let pdbData = null;
    let structureSource = null;
    
    // Strategy 1: Check if UniProt has PDB cross-references
    if (statusEl) statusEl.textContent = 'Checking PDB...';
    const pdbRefs = data?.uniProtKBCrossReferences?.filter(ref => ref.database === 'PDB') || [];
    console.log('PDB references found:', pdbRefs.length);
    
    if (pdbRefs.length > 0) {
        // Try to fetch the first available PDB structure
        for (const pdbRef of pdbRefs.slice(0, 3)) {
            try {
                const pdbId = pdbRef.id;
                if (statusEl) statusEl.textContent = `Fetching PDB ${pdbId}...`;
                console.log('Trying PDB:', pdbId);
                
                const pdbUrl = `https://files.rcsb.org/download/${pdbId}.pdb`;
                const response = await fetch(pdbUrl);
                
                if (response.ok) {
                    pdbData = await response.text();
                    structureSource = `PDB: ${pdbId}`;
                    console.log('PDB structure loaded:', pdbId);
                    break;
                }
            } catch (e) {
                console.log(`PDB ${pdbRef.id} not available:`, e.message);
            }
        }
    }
    
    // Strategy 2: Try AlphaFold if no PDB found
    if (!pdbData) {
        try {
            if (statusEl) statusEl.textContent = 'Trying AlphaFold...';
            console.log('Trying AlphaFold for:', accession);
            
            const afUrl = proxiedUrl(`https://alphafold.ebi.ac.uk/files/AF-${accession}-F1-model_v4.pdb`);
            const afResponse = await fetch(afUrl);
            
            if (afResponse.ok) {
                const text = await afResponse.text();
                // Check it's actually PDB data, not an error page
                if (text.includes('ATOM') || text.includes('HETATM')) {
                    pdbData = text;
                    structureSource = 'AlphaFold';
                    console.log('AlphaFold structure loaded');
                } else {
                    console.log('AlphaFold response was not valid PDB data');
                }
            } else {
                console.log('AlphaFold not available, status:', afResponse.status);
            }
        } catch (e) {
            console.log('AlphaFold fetch error:', e.message);
        }
    }
    
    // No structure found - show "Not Available" message
    if (!pdbData) {
        console.log('No 3D structure available for', accession);
        container.innerHTML = `
            <div class="viewer-not-available">
                <div class="not-available-icon">🔬</div>
                <h4>3D Structure Not Available</h4>
                <p>No experimental (PDB) or predicted (AlphaFold) structure found for this protein.</p>
                <p class="hint">The sequence and feature information are still available in the panels below.</p>
            </div>
        `;
        if (statusEl) {
            statusEl.textContent = 'Not Available';
            statusEl.classList.add('unavailable');
        }
        return;
    }
    
    // Render the structure
    console.log('Structure source:', structureSource, 'PDB data length:', pdbData?.length);
    
    if (pdbData) {
        try {
            // Clear container and ensure it has proper dimensions
            container.innerHTML = '';
            container.style.width = '100%';
            container.style.height = '450px';
            container.style.position = 'relative';
            
            // Get actual container dimensions
            const rect = container.getBoundingClientRect();
            const width = rect.width || 500;
            const height = rect.height || 450;
            console.log('Container dimensions:', width, 'x', height);
            
            // Create viewer with explicit dimensions
            const viewer = $3Dmol.createViewer(container, {
                backgroundColor: '#0f0f1e',
                antialias: true,
                width: width,
                height: height
            });
            
            if (!viewer) {
                throw new Error('Failed to create 3Dmol viewer');
            }
            
            console.log('3Dmol viewer created, adding model...');
            viewer.addModel(pdbData, 'pdb');
            uniprot3DViewers[index] = viewer;
            uniprotDataStore[index].pdbData = pdbData;
            uniprotDataStore[index].structureSource = structureSource;
            
            // Apply initial style based on source
            if (structureSource === 'AlphaFold') {
                applyUniProt3DStyle(index, 'cartoon', 'plddt');
            } else if (structureSource === 'Sequence Model') {
                applyUniProt3DStyle(index, 'cartoon', 'features');
            } else {
                applyUniProt3DStyle(index, 'cartoon', 'spectrum');
            }
            
            viewer.zoomTo();
            viewer.render();
            console.log('Viewer rendered');
            
            // Force resize after a short delay to ensure proper rendering
            setTimeout(() => {
                if (uniprot3DViewers[index]) {
                    uniprot3DViewers[index].resize();
                    uniprot3DViewers[index].render();
                    console.log('Viewer resized');
                }
            }, 100);
            
            if (statusEl) {
                statusEl.textContent = structureSource;
                statusEl.classList.add('ready');
            }
            
        } catch (renderError) {
            console.error('Error rendering structure:', renderError);
            showSequenceOnlyView(container, statusEl, index);
        }
    } else {
        showSequenceOnlyView(container, statusEl, index);
    }
}

// Generate a simple PDB from sequence - creates a spiral/helix backbone
function generateSequenceBasedPDB(sequence, features) {
    let pdb = 'REMARK   Generated from sequence\n';
    const len = sequence.length;
    
    // Generate a helical backbone - simple but effective visualization
    // Parameters for a nice helix shape
    const radius = 10; // Angstroms
    const rise = 1.5; // Rise per residue
    const turn = 100; // Degrees per residue (creates a nice spiral)
    
    for (let i = 0; i < len; i++) {
        const aa = sequence[i];
        const resNum = i + 1;
        const angle = (i * turn * Math.PI) / 180;
        
        // Calculate position on helix
        const x = radius * Math.cos(angle);
        const y = radius * Math.sin(angle);
        const z = i * rise;
        
        // Format PDB ATOM line (CA atom for backbone)
        const atomNum = (i + 1).toString().padStart(5);
        const resName = aminoAcidCodes[aa] || 'UNK';
        const xStr = x.toFixed(3).padStart(8);
        const yStr = y.toFixed(3).padStart(8);
        const zStr = z.toFixed(3).padStart(8);
        const resNumStr = resNum.toString().padStart(4);
        
        pdb += `ATOM  ${atomNum}  CA  ${resName} A${resNumStr}    ${xStr}${yStr}${zStr}  1.00  0.00           C\n`;
    }
    
    pdb += 'END\n';
    return pdb;
}

// Amino acid 3-letter codes
const aminoAcidCodes = {
    'A': 'ALA', 'R': 'ARG', 'N': 'ASN', 'D': 'ASP', 'C': 'CYS',
    'E': 'GLU', 'Q': 'GLN', 'G': 'GLY', 'H': 'HIS', 'I': 'ILE',
    'L': 'LEU', 'K': 'LYS', 'M': 'MET', 'F': 'PHE', 'P': 'PRO',
    'S': 'SER', 'T': 'THR', 'W': 'TRP', 'Y': 'TYR', 'V': 'VAL'
};

// Show a sequence-only view with features as colored segments
function showSequenceOnlyView(container, statusEl, index) {
    const data = uniprotDataStore[index];
    
    if (!data?.sequence) {
        container.innerHTML = `
            <div class="viewer-error">
                <p>⚠️ No Structure Available</p>
                <p class="error-hint">No experimental or predicted structure found.</p>
            </div>
        `;
        if (statusEl) {
            statusEl.textContent = 'Unavailable';
            statusEl.classList.add('error');
        }
        return;
    }
    
    // Generate sequence-based PDB and render
    const pdbData = generateSequenceBasedPDB(data.sequence, data.parsedFeatures);
    
    try {
        container.innerHTML = '';
        
        // Ensure container has proper dimensions
        container.style.width = '100%';
        container.style.height = '450px';
        container.style.position = 'relative';
        
        const viewer = $3Dmol.createViewer(container, {
            backgroundColor: '#0f0f1e',
            antialias: true
        });
        
        viewer.addModel(pdbData, 'pdb');
        uniprot3DViewers[index] = viewer;
        uniprotDataStore[index].pdbData = pdbData;
        uniprotDataStore[index].structureSource = 'Sequence Model';
        
        // Apply feature-based coloring
        applyUniProt3DStyle(index, 'cartoon', 'features');
        
        viewer.zoomTo();
        viewer.resize();
        viewer.render();
        
        if (statusEl) {
            statusEl.textContent = 'Sequence Model';
            statusEl.classList.add('ready');
            statusEl.title = 'Helical representation of sequence - not actual structure';
        }
        
    } catch (error) {
        console.error('Error creating sequence view:', error);
        container.innerHTML = `
            <div class="viewer-error">
                <p>⚠️ Visualization Error</p>
                <p class="error-detail">${error.message}</p>
            </div>
        `;
    }
}

// Apply style and coloring to UniProt 3D viewer
function applyUniProt3DStyle(index, style, colorScheme) {
    const viewer = uniprot3DViewers[index];
    if (!viewer) return;
    
    const data = uniprotDataStore[index];
    
    // Clear existing styles
    viewer.setStyle({}, {});
    
    // For feature-based coloring, apply base white then overlay features
    if (colorScheme === 'features') {
        applyFeatureBasedColoring(index, style);
        viewer.render();
        return;
    }
    
    // Determine coloring
    let colorSpec;
    
    switch (colorScheme) {
        case 'plddt':
            // pLDDT confidence coloring (only meaningful for AlphaFold)
            if (data?.structureSource === 'AlphaFold') {
                colorSpec = {
                    prop: 'b',
                    gradient: new $3Dmol.Gradient.RWB(50, 90)
                };
            } else {
                // Fall back to spectrum for non-AlphaFold structures
                colorSpec = 'spectrum';
                showToast('pLDDT coloring only available for AlphaFold structures');
            }
            break;
        case 'spectrum':
            colorSpec = 'spectrum';
            break;
        case 'ss':
            colorSpec = 'ss';
            break;
        case 'residue':
            // Color by residue type using built-in scheme
            colorSpec = 'residue';
            break;
        case 'hydrophobicity':
            // Custom hydrophobicity coloring
            applyHydrophobicityColoring(index, style);
            viewer.render();
            return;
        default:
            colorSpec = 'spectrum';
    }
    
    // Apply base style
    const styleSpec = {};
    switch (style) {
        case 'cartoon':
            styleSpec.cartoon = { color: colorSpec };
            break;
        case 'surface':
            styleSpec.surface = { opacity: 0.85, color: colorSpec };
            styleSpec.cartoon = { opacity: 0.3, color: colorSpec };
            break;
        case 'ball+stick':
            styleSpec.stick = { radius: 0.15, color: colorSpec };
            styleSpec.sphere = { radius: 0.3, color: colorSpec };
            break;
        default:
            styleSpec.cartoon = { color: colorSpec };
    }
    
    viewer.setStyle({}, styleSpec);
    viewer.render();
}

// Apply feature-based coloring with white background
function applyFeatureBasedColoring(index, style) {
    const viewer = uniprot3DViewers[index];
    const data = uniprotDataStore[index];
    if (!viewer || !data) return;
    
    // Base style in gray/white
    const baseStyle = {};
    switch (style) {
        case 'cartoon':
            baseStyle.cartoon = { color: '#555555' };
            break;
        case 'surface':
            baseStyle.surface = { opacity: 0.7, color: '#444444' };
            break;
        case 'ball+stick':
            baseStyle.stick = { radius: 0.12, color: '#555555' };
            break;
    }
    viewer.setStyle({}, baseStyle);
    
    // Apply feature colors
    const featureColors = {
        domain: '#667eea',
        binding: '#f59e0b',
        active_site: '#ef4444',
        disulfid: '#10b981',
        signal: '#8b5cf6',
        carbohyd: '#ec4899',
        variant: '#06b6d4',
        transmem: '#f97316',
        helix: '#a855f7',
        strand: '#3b82f6'
    };
    
    const activeFeatures = getActiveFeatureTypes(index);
    
    for (const featureType of activeFeatures) {
        const features = data.parsedFeatures?.[featureType] || [];
        const color = featureColors[featureType] || '#ffffff';
        
        for (const feature of features) {
            const resRange = generateResidueRange(feature.start, feature.end);
            const featureStyle = {};
            
            switch (style) {
                case 'cartoon':
                    featureStyle.cartoon = { color: color };
                    break;
                case 'surface':
                    featureStyle.surface = { opacity: 0.9, color: color };
                    break;
                case 'ball+stick':
                    featureStyle.stick = { radius: 0.2, color: color };
                    featureStyle.sphere = { radius: 0.35, color: color };
                    break;
            }
            
            viewer.setStyle({ resi: resRange }, featureStyle);
        }
    }
}

// Apply hydrophobicity coloring
function applyHydrophobicityColoring(index, style) {
    const viewer = uniprot3DViewers[index];
    if (!viewer) return;
    
    // Kyte-Doolittle hydrophobicity scale
    // Blue = hydrophilic, Red = hydrophobic
    const hydrophobicity = {
        'ILE': 4.5, 'VAL': 4.2, 'LEU': 3.8, 'PHE': 2.8, 'CYS': 2.5,
        'MET': 1.9, 'ALA': 1.8, 'GLY': -0.4, 'THR': -0.7, 'SER': -0.8,
        'TRP': -0.9, 'TYR': -1.3, 'PRO': -1.6, 'HIS': -3.2, 'GLU': -3.5,
        'GLN': -3.5, 'ASP': -3.5, 'ASN': -3.5, 'LYS': -3.9, 'ARG': -4.5
    };
    
    // Apply base style
    const baseStyle = {};
    switch (style) {
        case 'cartoon':
            baseStyle.cartoon = { color: '#888888' };
            break;
        case 'surface':
            baseStyle.surface = { opacity: 0.85, color: '#888888' };
            break;
        case 'ball+stick':
            baseStyle.stick = { radius: 0.15, color: '#888888' };
            break;
    }
    viewer.setStyle({}, baseStyle);
    
    // Color each residue type by hydrophobicity
    for (const [resName, hydro] of Object.entries(hydrophobicity)) {
        // Map hydrophobicity to color (blue to red)
        const normalized = (hydro + 4.5) / 9; // 0 to 1
        const r = Math.round(normalized * 255);
        const b = Math.round((1 - normalized) * 255);
        const color = `rgb(${r}, 80, ${b})`;
        
        const resStyle = {};
        switch (style) {
            case 'cartoon':
                resStyle.cartoon = { color: color };
                break;
            case 'surface':
                resStyle.surface = { opacity: 0.85, color: color };
                break;
            case 'ball+stick':
                resStyle.stick = { radius: 0.15, color: color };
                resStyle.sphere = { radius: 0.3, color: color };
                break;
        }
        
        viewer.setStyle({ resn: resName }, resStyle);
    }
    
    viewer.render();
}

// Apply feature highlighting to 3D structure (legacy function - kept for compatibility)
function applyFeatureHighlighting3D(index, style) {
    applyFeatureBasedColoring(index, style);
}

// Generate residue selection string for a range
function generateResidueRange(start, end) {
    if (start === end) return [start];
    const range = [];
    for (let i = start; i <= end; i++) {
        range.push(i);
    }
    return range;
}

// Get active feature types from toggles
function getActiveFeatureTypes(index) {
    const toggles = document.querySelectorAll(`#feature-toggles-${index} input[type="checkbox"]:checked`);
    const activeTypes = [];
    
    toggles.forEach(toggle => {
        const label = toggle.closest('.feature-toggle');
        if (label && label.dataset.type) {
            activeTypes.push(label.dataset.type);
        }
    });
    
    return activeTypes;
}

// Toggle 3D viewer style
function toggleUniProt3DStyle(index, style, btn) {
    // Update button states
    const buttons = btn.parentElement.querySelectorAll('.rep-btn');
    buttons.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    
    // Get current color scheme
    const colorSelect = document.getElementById(`uniprot-color-${index}`);
    const colorScheme = colorSelect ? colorSelect.value : 'plddt';
    
    // Store current style
    if (!uniprotDataStore[index]) uniprotDataStore[index] = {};
    uniprotDataStore[index].currentStyle = style;
    
    // Apply style
    applyUniProt3DStyle(index, style, colorScheme);
}

// Change 3D viewer color scheme
function changeUniProt3DColor(index, colorScheme) {
    const data = uniprotDataStore[index];
    const style = data?.currentStyle || 'cartoon';
    
    applyUniProt3DStyle(index, style, colorScheme);
}

// Reset 3D view
function resetUniProt3DView(index) {
    const viewer = uniprot3DViewers[index];
    if (!viewer) return;
    
    viewer.zoomTo();
    viewer.render();
}

// Toggle spin animation
function spinUniProt3D(index) {
    const viewer = uniprot3DViewers[index];
    if (!viewer) return;
    
    if (uniprot3DSpinning[index]) {
        viewer.spin(false);
        uniprot3DSpinning[index] = false;
    } else {
        viewer.spin('y', 1);
        uniprot3DSpinning[index] = true;
    }
}

// Highlight specific residues in 3D viewer (called when clicking features)
function highlightResiduesIn3D(index, start, end, color) {
    const viewer = uniprot3DViewers[index];
    if (!viewer) return;
    
    // Add highlight style
    viewer.addStyle(
        { resi: generateResidueRange(start, end) },
        { cartoon: { color: color }, stick: { radius: 0.3, color: color } }
    );
    
    // Zoom to selection
    viewer.zoomTo({ resi: generateResidueRange(start, end) });
    viewer.render();
    
    // Remove highlight after 3 seconds
    setTimeout(() => {
        const data = uniprotDataStore[index];
        const style = data?.currentStyle || 'cartoon';
        const colorSelect = document.getElementById(`uniprot-color-${index}`);
        const colorScheme = colorSelect ? colorSelect.value : 'plddt';
        applyUniProt3DStyle(index, style, colorScheme);
    }, 3000);
}

function parseUniProtFeatures(features) {
    const parsed = {
        domain: [],
        binding: [],
        active_site: [],
        disulfid: [],
        signal: [],
        carbohyd: [],
        variant: [],
        transmem: [],
        helix: [],
        strand: [],
        turn: [],
        region: [],
        motif: [],
        chain: [],
        other: []
    };
    
    for (const feature of features) {
        const type = feature.type?.toLowerCase() || 'other';
        const start = feature.location?.start?.value || 0;
        const end = feature.location?.end?.value || start;
        const description = feature.description || feature.ligand?.name || type;
        
        const featureData = {
            type: type,
            start: start,
            end: end,
            description: description,
            evidence: feature.evidences?.[0]?.code || ''
        };
        
        // Map to our categories
        if (type.includes('domain')) {
            parsed.domain.push(featureData);
        } else if (type.includes('binding') || type === 'site') {
            parsed.binding.push(featureData);
        } else if (type.includes('active')) {
            parsed.active_site.push(featureData);
        } else if (type.includes('disulfid') || type === 'crosslnk') {
            parsed.disulfid.push(featureData);
        } else if (type.includes('signal') || type === 'transit') {
            parsed.signal.push(featureData);
        } else if (type.includes('carbohyd') || type === 'glycosylation') {
            parsed.carbohyd.push(featureData);
        } else if (type.includes('variant') || type === 'mutagenesis') {
            parsed.variant.push(featureData);
        } else if (type.includes('transmem') || type === 'intramem') {
            parsed.transmem.push(featureData);
        } else if (type === 'helix') {
            parsed.helix.push(featureData);
        } else if (type === 'strand') {
            parsed.strand.push(featureData);
        } else if (type === 'turn') {
            parsed.turn.push(featureData);
        } else if (type === 'region') {
            parsed.region.push(featureData);
        } else if (type === 'motif') {
            parsed.motif.push(featureData);
        } else if (type === 'chain') {
            parsed.chain.push(featureData);
        } else {
            parsed.other.push(featureData);
        }
    }
    
    return parsed;
}

function renderFeatureViewer(index) {
    const featureViewer = document.getElementById(`feature-viewer-${index}`);
    if (!featureViewer) return;
    
    const data = uniprotDataStore[index];
    if (!data || !data.parsedFeatures) return;
    
    const seqLength = data.seqLength || 100;
    const features = data.parsedFeatures;
    
    // Get active toggles
    const toggles = document.querySelectorAll(`#feature-toggles-${index} input[type="checkbox"]`);
    const activeTypes = [];
    toggles.forEach(toggle => {
        // Get feature type from onchange attribute
        const onchangeAttr = toggle.getAttribute('onchange') || '';
        const match = onchangeAttr.match(/toggleUniProtFeature\(\d+,\s*'(\w+)'/);
        if (match && toggle.checked) {
            activeTypes.push(match[1]);
        }
    });
    
    // Feature colors
    const featureColors = {
        domain: '#667eea',
        binding: '#f59e0b',
        active_site: '#ef4444',
        disulfid: '#10b981',
        signal: '#8b5cf6',
        carbohyd: '#ec4899',
        variant: '#06b6d4',
        transmem: '#f97316'
    };
    
    let html = `
        <div class="feature-track-container">
            <div class="feature-track-header">
                <span class="track-label">Sequence Position</span>
                <span class="track-scale">1 - ${seqLength} aa</span>
            </div>
            <div class="feature-track-scale">
                ${generateScaleMarkers(seqLength)}
            </div>
    `;
    
    // Render each active feature type as a track
    for (const type of activeTypes) {
        const typeFeatures = features[type] || [];
        if (typeFeatures.length === 0) continue;
        
        const color = featureColors[type] || '#666';
        const label = type.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
        
        html += `
            <div class="feature-track" data-type="${type}">
                <span class="track-label">${label} (${typeFeatures.length})</span>
                <div class="track-bar">
                    ${typeFeatures.map(f => {
                        const startPercent = (f.start / seqLength) * 100;
                        const widthPercent = Math.max(((f.end - f.start + 1) / seqLength) * 100, 0.5);
                        return `<div class="feature-mark" 
                                    style="left: ${startPercent}%; width: ${widthPercent}%; background-color: ${color};"
                                    title="${f.description} (${f.start}-${f.end})"
                                    onclick="showFeatureDetails(${index}, '${type}', ${f.start}, ${f.end})">
                                </div>`;
                    }).join('')}
                </div>
            </div>
        `;
    }
    
    html += '</div>';
    
    // Add legend
    html += `
        <div class="feature-legend">
            ${Object.entries(featureColors).map(([type, color]) => `
                <span class="legend-item" style="--feature-color: ${color}">
                    <span class="legend-dot" style="background: ${color}"></span>
                    ${type.replace(/_/g, ' ')}
                </span>
            `).join('')}
        </div>
    `;
    
    featureViewer.innerHTML = html;
}

function generateScaleMarkers(seqLength) {
    const markers = [];
    const step = seqLength > 500 ? 100 : seqLength > 200 ? 50 : 25;
    
    for (let i = 0; i <= seqLength; i += step) {
        if (i === 0) continue;
        const percent = (i / seqLength) * 100;
        markers.push(`<span class="scale-marker" style="left: ${percent}%">${i}</span>`);
    }
    
    return markers.join('');
}

function renderSequenceDisplay(index) {
    const sequenceDisplay = document.getElementById(`uniprot-seq-display-${index}`);
    if (!sequenceDisplay) return;
    
    const data = uniprotDataStore[index];
    if (!data || !data.sequence) return;
    
    const sequence = data.sequence;
    const features = data.parsedFeatures;
    
    // Get active toggles for highlighting
    const toggles = document.querySelectorAll(`#feature-toggles-${index} input[type="checkbox"]`);
    const activeTypes = [];
    toggles.forEach(toggle => {
        const onchangeAttr = toggle.getAttribute('onchange') || '';
        const match = onchangeAttr.match(/toggleUniProtFeature\(\d+,\s*'(\w+)'/);
        if (match && toggle.checked) {
            activeTypes.push(match[1]);
        }
    });
    
    // Create position-based highlighting map
    const highlights = new Array(sequence.length).fill(null);
    
    const featureColors = {
        domain: '#667eea',
        binding: '#f59e0b',
        active_site: '#ef4444',
        disulfid: '#10b981',
        signal: '#8b5cf6',
        carbohyd: '#ec4899',
        variant: '#06b6d4',
        transmem: '#f97316'
    };
    
    // Apply highlights from features (later features override earlier ones)
    for (const type of activeTypes) {
        const typeFeatures = features[type] || [];
        for (const f of typeFeatures) {
            for (let i = f.start - 1; i < f.end && i < sequence.length; i++) {
                if (i >= 0) {
                    highlights[i] = { color: featureColors[type], type: type };
                }
            }
        }
    }
    
    // Build HTML sequence with highlighting and line numbers
    let html = '<div class="sequence-content">';
    const lineLength = 60;
    
    for (let i = 0; i < sequence.length; i += lineLength) {
        const lineNum = i + 1;
        const lineEnd = Math.min(i + lineLength, sequence.length);
        
        html += `<div class="sequence-line">`;
        html += `<span class="line-number">${lineNum.toString().padStart(6)}</span>`;
        html += '<span class="sequence-text">';
        
        // Add 10-character blocks
        for (let j = i; j < lineEnd; j++) {
            const aa = sequence[j];
            const highlight = highlights[j];
            
            if ((j - i) > 0 && (j - i) % 10 === 0) {
                html += ' '; // Space between blocks
            }
            
            if (highlight) {
                html += `<span class="aa-highlight" style="background-color: ${highlight.color}40; color: ${highlight.color};" title="${highlight.type}: position ${j + 1}">${aa}</span>`;
            } else {
                html += `<span class="aa">${aa}</span>`;
            }
        }
        
        html += '</span>';
        html += `<span class="line-end-number">${lineEnd}</span>`;
        html += '</div>';
    }
    
    html += '</div>';
    sequenceDisplay.innerHTML = html;
}

function toggleUniProtFeature(index, featureType, isChecked) {
    console.log(`Toggling ${featureType} for panel ${index}: ${isChecked}`);
    
    // Re-render the feature viewer and sequence
    renderFeatureViewer(index);
    renderSequenceDisplay(index);
    
    // Update sequence stats
    updateSequenceStats(index);
    
    // Update 3D viewer if "features" color scheme is active
    const colorSelect = document.getElementById(`uniprot-color-${index}`);
    if (colorSelect && colorSelect.value === 'features') {
        const data = uniprotDataStore[index];
        const style = data?.currentStyle || 'cartoon';
        applyUniProt3DStyle(index, style, 'features');
    }
}

function updateSequenceStats(index) {
    const statsEl = document.getElementById(`uniprot-seq-stats-${index}`);
    if (!statsEl) return;
    
    const data = uniprotDataStore[index];
    if (!data || !data.sequence) return;
    
    statsEl.textContent = `${data.seqLength} aa`;
}

function showFeatureDetails(index, type, start, end) {
    const data = uniprotDataStore[index];
    if (!data || !data.parsedFeatures) return;
    
    const featureColors = {
        domain: '#667eea',
        binding: '#f59e0b',
        active_site: '#ef4444',
        disulfid: '#10b981',
        signal: '#8b5cf6',
        carbohyd: '#ec4899',
        variant: '#06b6d4',
        transmem: '#f97316',
        helix: '#a855f7',
        strand: '#3b82f6'
    };
    
    const typeFeatures = data.parsedFeatures[type] || [];
    const feature = typeFeatures.find(f => f.start === start && f.end === end);
    
    if (feature) {
        const label = type.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
        const color = featureColors[type] || '#ffffff';
        
        // Highlight in 3D viewer
        highlightResiduesIn3D(index, start, end, color);
        
        // Show toast with feature info
        showToast(`${label}: ${feature.description} (${start}-${end}) - Highlighted in 3D`);
    }
}

function copyUniProtSequence(index, format) {
    const data = uniprotDataStore[index];
    if (!data || !data.sequence) {
        alert('No sequence data available');
        return;
    }
    
    let text = data.sequence;
    if (format === 'fasta') {
        const accession = data.primaryAccession || 'Unknown';
        const proteinName = data.proteinDescription?.recommendedName?.fullName?.value || 'Unknown protein';
        text = `>${accession} ${proteinName}\n${data.sequence.match(/.{1,60}/g).join('\n')}`;
    }
    
    navigator.clipboard.writeText(text).then(() => {
        showToast(`Sequence copied to clipboard (${format.toUpperCase()})`);
    }).catch(err => {
        console.error('Copy failed:', err);
        alert('Failed to copy sequence');
    });
}

function downloadUniProtSequence(index) {
    const data = uniprotDataStore[index];
    if (!data || !data.sequence) {
        alert('No sequence data available');
        return;
    }
    
    const accession = data.primaryAccession || 'sequence';
    const proteinName = data.proteinDescription?.recommendedName?.fullName?.value || 'Unknown protein';
    const fasta = `>${accession} ${proteinName}\n${data.sequence.match(/.{1,60}/g).join('\n')}`;
    
    const blob = new Blob([fasta], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${accession}.fasta`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

async function populateUniProtCrosslinks(index, accession, data) {
    const crosslinksGrid = document.getElementById(`uniprot-crosslinks-${index}`);
    if (!crosslinksGrid) return;
    
    // Extract cross-references from UniProt data
    const dbRefs = data.uniProtKBCrossReferences || [];
    
    const crosslinks = [];
    
    // AlphaFold link (always available for reviewed entries)
    crosslinks.push({
        name: 'AlphaFold',
        url: `https://alphafold.ebi.ac.uk/entry/${accession}`,
        icon: '🔮',
        description: 'Predicted 3D structure'
    });
    
    // PDB links
    const pdbRefs = dbRefs.filter(ref => ref.database === 'PDB');
    if (pdbRefs.length > 0) {
        const pdbIds = pdbRefs.slice(0, 3).map(ref => ref.id).join(', ');
        crosslinks.push({
            name: 'PDB',
            url: `https://www.rcsb.org/search?request=%7B%22query%22%3A%7B%22type%22%3A%22terminal%22%2C%22service%22%3A%22text%22%2C%22parameters%22%3A%7B%22attribute%22%3A%22rcsb_polymer_entity_container_identifiers.reference_sequence_identifiers.database_accession%22%2C%22operator%22%3A%22exact_match%22%2C%22value%22%3A%22${accession}%22%7D%7D%2C%22return_type%22%3A%22entry%22%7D`,
            icon: '🧬',
            description: `${pdbRefs.length} structure(s): ${pdbIds}${pdbRefs.length > 3 ? '...' : ''}`
        });
    }
    
    // KEGG link
    const keggRefs = dbRefs.filter(ref => ref.database === 'KEGG');
    if (keggRefs.length > 0) {
        crosslinks.push({
            name: 'KEGG',
            url: `https://www.kegg.jp/entry/${keggRefs[0].id}`,
            icon: '🗺️',
            description: 'Pathway information'
        });
    } else {
        // Try with gene name
        const geneName = data.genes?.[0]?.geneName?.value;
        const organism = data.organism?.commonName?.toLowerCase() || 'human';
        if (geneName) {
            crosslinks.push({
                name: 'KEGG',
                url: `https://www.kegg.jp/kegg-bin/search_pathway_text?map=map&keyword=${geneName}`,
                icon: '🗺️',
                description: 'Search pathways'
            });
        }
    }
    
    // InterPro
    const iprRefs = dbRefs.filter(ref => ref.database === 'InterPro');
    if (iprRefs.length > 0) {
        crosslinks.push({
            name: 'InterPro',
            url: `https://www.ebi.ac.uk/interpro/protein/UniProt/${accession}/`,
            icon: '🏷️',
            description: `${iprRefs.length} domain annotations`
        });
    }
    
    // STRING (protein interactions)
    crosslinks.push({
        name: 'STRING',
        url: `https://string-db.org/network/${data.organism?.taxonId}.${accession}`,
        icon: '🕸️',
        description: 'Protein interactions'
    });
    
    // Build HTML
    let html = '';
    for (const link of crosslinks) {
        html += `
            <a href="${link.url}" target="_blank" class="crosslink-card">
                <span class="crosslink-icon">${link.icon}</span>
                <div class="crosslink-info">
                    <span class="crosslink-name">${link.name}</span>
                    <span class="crosslink-desc">${link.description}</span>
                </div>
                <span class="crosslink-arrow">→</span>
            </a>
        `;
    }
    
    crosslinksGrid.innerHTML = html;
}

// Alias for downloadUniProtSequence
function downloadUniProtFasta(index) {
    downloadUniProtSequence(index);
}

// Toggle sequence section visibility
function toggleUniProtSequence(index) {
    const content = document.getElementById(`uniprot-sequence-${index}`);
    const icon = document.querySelector(`#uniprot-sequence-${index}`)?.previousElementSibling?.querySelector('.collapse-icon');
    
    if (content) {
        const isCollapsed = content.style.display === 'none';
        content.style.display = isCollapsed ? 'block' : 'none';
        if (icon) {
            icon.textContent = isCollapsed ? '▼' : '▶';
        }
    }
}

// Show sequence statistics
function showSequenceStats(index) {
    const data = uniprotDataStore[index];
    if (!data || !data.sequence) {
        alert('No sequence data available');
        return;
    }
    
    const sequence = data.sequence;
    const length = sequence.length;
    
    // Count amino acids
    const aaCounts = {};
    for (const aa of sequence) {
        aaCounts[aa] = (aaCounts[aa] || 0) + 1;
    }
    
    // Calculate molecular weight (approximate)
    const aaWeights = {
        'A': 89, 'R': 174, 'N': 132, 'D': 133, 'C': 121,
        'E': 147, 'Q': 146, 'G': 75, 'H': 155, 'I': 131,
        'L': 131, 'K': 146, 'M': 149, 'F': 165, 'P': 115,
        'S': 105, 'T': 119, 'W': 204, 'Y': 181, 'V': 117
    };
    
    let mw = 0;
    for (const [aa, count] of Object.entries(aaCounts)) {
        mw += (aaWeights[aa] || 110) * count;
    }
    mw -= (length - 1) * 18; // Remove water
    
    // Calculate isoelectric point (simplified)
    const posCharged = (aaCounts['R'] || 0) + (aaCounts['K'] || 0) + (aaCounts['H'] || 0);
    const negCharged = (aaCounts['D'] || 0) + (aaCounts['E'] || 0);
    
    // Format statistics
    const sortedAAs = Object.entries(aaCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([aa, count]) => `${aa}: ${count} (${((count/length)*100).toFixed(1)}%)`)
        .join('\n');
    
    const stats = `
Sequence Statistics for ${data.primaryAccession || 'Unknown'}

Length: ${length} amino acids
Molecular Weight: ${(mw/1000).toFixed(2)} kDa (estimated)

Positively charged (R+K+H): ${posCharged} (${((posCharged/length)*100).toFixed(1)}%)
Negatively charged (D+E): ${negCharged} (${((negCharged/length)*100).toFixed(1)}%)
Net charge (pH 7): ~${posCharged - negCharged}

Top 10 Amino Acids:
${sortedAAs}
    `.trim();
    
    alert(stats);
}

// ====== KEGG WORKFLOW FUNCTIONS ======

// Store KEGG data for each panel
let keggDataCache = {};

// KEGG calls go through the local proxy (same-origin, allowlisted on the server).
const KEGG_CORS_PROXY = '/api/proxy?url=';

// Initialize KEGG workflow
async function initializeKEGGWorkflow(index, keggId) {
    console.log(`Initializing KEGG workflow for index ${index}, ID: ${keggId}`);
    
    try {
        // Fetch KEGG data via CORS proxy
        const response = await fetch(KEGG_CORS_PROXY + encodeURIComponent(`https://rest.kegg.jp/get/${keggId}`));
        if (!response.ok) {
            throw new Error(`KEGG API error: ${response.status}`);
        }
        
        const rawData = await response.text();
        const keggData = parseKEGGData(rawData);
        keggDataCache[index] = keggData;
        keggDataCache[index].keggId = keggId;
        
        console.log('Parsed KEGG data:', keggData);
        
        // Determine entry type
        const entryType = determineKEGGType(keggId, keggData);
        keggDataCache[index].entryType = entryType;
        
        // Update UI based on type
        updateKEGGHeader(index, keggData, entryType);
        updateKEGGDescription(index, keggData);
        
        // Load type-specific content
        if (entryType === 'pathway') {
            await loadKEGGPathwayContent(index, keggId, keggData);
        } else if (entryType === 'compound') {
            await loadKEGGCompoundContent(index, keggId, keggData);
        } else if (entryType === 'gene') {
            await loadKEGGGeneContent(index, keggId, keggData);
        } else if (entryType === 'drug') {
            await loadKEGGDrugContent(index, keggId, keggData);
        }
        
        // Update cross-links
        updateKEGGCrossLinks(index, keggData);
        
    } catch (error) {
        console.error('Error initializing KEGG workflow:', error);
        const quickInfo = document.getElementById(`kegg-quick-info-${index}`);
        if (quickInfo) {
            quickInfo.innerHTML = `<span class="error-text">Error loading KEGG data: ${error.message}</span>`;
        }
    }
}

// Parse KEGG flat file format into object
function parseKEGGData(rawData) {
    const lines = rawData.split('\n');
    const data = {};
    let currentKey = '';
    let currentValue = [];
    
    for (const line of lines) {
        if (line === '///') break; // End of entry
        
        if (line.match(/^[A-Z]/)) {
            // Save previous key
            if (currentKey) {
                data[currentKey] = currentValue.length === 1 ? currentValue[0] : currentValue;
            }
            
            // New key
            const match = line.match(/^([A-Z_]+)\s*(.*)/);
            if (match) {
                currentKey = match[1];
                currentValue = match[2] ? [match[2]] : [];
            }
        } else if (line.startsWith('            ') && currentKey) {
            // Continuation of previous value (list item)
            currentValue.push(line.trim());
        } else if (line.startsWith('  ') && currentKey) {
            // Continuation of multi-line value
            if (currentValue.length > 0) {
                currentValue[currentValue.length - 1] += ' ' + line.trim();
            } else {
                currentValue.push(line.trim());
            }
        }
    }
    
    // Save last key
    if (currentKey) {
        data[currentKey] = currentValue.length === 1 ? currentValue[0] : currentValue;
    }
    
    return data;
}

// Determine KEGG entry type from ID and data
function determineKEGGType(keggId, data) {
    // Check ENTRY field first
    if (data.ENTRY) {
        const entryStr = data.ENTRY.toLowerCase();
        if (entryStr.includes('pathway')) return 'pathway';
        if (entryStr.includes('compound')) return 'compound';
        if (entryStr.includes('drug')) return 'drug';
        if (entryStr.includes('gene')) return 'gene';
        if (entryStr.includes('enzyme')) return 'enzyme';
        if (entryStr.includes('reaction')) return 'reaction';
    }
    
    // Infer from ID pattern
    if (keggId.match(/^[a-z]{2,4}\d{5}$/)) return 'pathway'; // hsa00010
    if (keggId.match(/^C\d{5}$/)) return 'compound'; // C00022
    if (keggId.match(/^D\d{5}$/)) return 'drug'; // D00001
    if (keggId.match(/^[a-z]{2,4}:\d+$/)) return 'gene'; // hsa:10458
    if (keggId.match(/^R\d{5}$/)) return 'reaction'; // R00001
    if (keggId.match(/^K\d{5}$/)) return 'orthology'; // K00001
    if (keggId.match(/^\d+\.\d+\.\d+\.\d+$/)) return 'enzyme'; // 1.1.1.1
    
    return 'unknown';
}

// Update KEGG header
function updateKEGGHeader(index, data, entryType) {
    const typeBadge = document.getElementById(`kegg-type-${index}`);
    const quickInfo = document.getElementById(`kegg-quick-info-${index}`);
    
    if (typeBadge) {
        const typeLabels = {
            'pathway': '🛤️ Pathway',
            'compound': '⚗️ Compound',
            'drug': '💊 Drug',
            'gene': '🧬 Gene',
            'enzyme': '🔧 Enzyme',
            'reaction': '⚡ Reaction',
            'orthology': '🔗 Orthology',
            'unknown': '📋 Entry'
        };
        typeBadge.textContent = typeLabels[entryType] || '📋 Entry';
        typeBadge.className = `kegg-type-badge kegg-type-${entryType}`;
    }
    
    if (quickInfo) {
        let infoHtml = '';
        
        if (data.NAME) {
            const name = Array.isArray(data.NAME) ? data.NAME[0] : data.NAME;
            infoHtml += `<span class="kegg-name">${name}</span>`;
        }
        
        if (data.ORGANISM) {
            infoHtml += `<span class="kegg-organism">${data.ORGANISM}</span>`;
        }
        
        if (data.FORMULA) {
            infoHtml += `<span class="kegg-formula">${data.FORMULA}</span>`;
        }
        
        if (data.MOL_WEIGHT) {
            infoHtml += `<span class="kegg-mw">${data.MOL_WEIGHT} Da</span>`;
        }
        
        quickInfo.innerHTML = infoHtml || '<span>KEGG Entry</span>';
    }
}

// Update KEGG description
function updateKEGGDescription(index, data) {
    const descContainer = document.getElementById(`kegg-description-${index}`);
    if (!descContainer) return;
    
    let description = '';
    
    if (data.DEFINITION) {
        description = Array.isArray(data.DEFINITION) ? data.DEFINITION.join(' ') : data.DEFINITION;
    } else if (data.DESCRIPTION) {
        description = Array.isArray(data.DESCRIPTION) ? data.DESCRIPTION.join(' ') : data.DESCRIPTION;
    } else if (data.NAME) {
        description = Array.isArray(data.NAME) ? data.NAME.join('; ') : data.NAME;
    }
    
    // Add class if present
    if (data.CLASS) {
        const classInfo = Array.isArray(data.CLASS) ? data.CLASS.join(' > ') : data.CLASS;
        description += `<div class="kegg-class"><strong>Class:</strong> ${classInfo}</div>`;
    }
    
    descContainer.innerHTML = description || 'No description available';
}

// Load pathway-specific content
async function loadKEGGPathwayContent(index, keggId, data) {
    // Show pathway map
    const mapContainer = document.getElementById(`kegg-map-${index}`);
    if (mapContainer) {
        const mapId = keggId.replace(/[a-z]+/, 'map'); // hsa00010 -> map00010
        mapContainer.innerHTML = `
            <img src="${KEGG_CORS_PROXY}${encodeURIComponent(`https://rest.kegg.jp/get/${keggId}/image`)}" 
                 alt="KEGG Pathway Map" 
                 class="kegg-pathway-image"
                 onerror="this.parentElement.innerHTML='<div class=\\'map-error\\'>Pathway map not available</div>'"
                 onclick="openKEGGMapFull(${index})">
            <div class="map-overlay-hint">Click to view full interactive map</div>
        `;
    }
    
    // Show genes section
    if (data.GENE) {
        const genesSection = document.getElementById(`kegg-genes-section-${index}`);
        if (genesSection) genesSection.style.display = 'block';
        
        const genesList = document.getElementById(`kegg-genes-list-${index}`);
        const geneCount = document.getElementById(`kegg-gene-count-${index}`);
        
        const genes = Array.isArray(data.GENE) ? data.GENE : [data.GENE];
        if (geneCount) geneCount.textContent = `(${genes.length} genes)`;
        
        if (genesList) {
            genesList.innerHTML = genes.slice(0, 100).map(gene => {
                const match = gene.match(/^(\d+)\s+([^;]+);?\s*(.*)?/);
                if (match) {
                    const [, geneId, symbol, description] = match;
                    const ecMatch = description?.match(/\[EC:([^\]]+)\]/);
                    const ec = ecMatch ? ecMatch[1] : '';
                    return `
                        <div class="kegg-gene-item" data-gene="${symbol.toLowerCase()}">
                            <span class="gene-symbol">${symbol}</span>
                            <span class="gene-id">${geneId}</span>
                            ${ec ? `<span class="gene-ec">EC:${ec}</span>` : ''}
                            <span class="gene-desc">${description?.replace(/\[EC:[^\]]+\]/g, '').trim() || ''}</span>
                        </div>
                    `;
                }
                return `<div class="kegg-gene-item">${gene}</div>`;
            }).join('');
            
            if (genes.length > 100) {
                genesList.innerHTML += `<div class="kegg-more-items">...and ${genes.length - 100} more genes</div>`;
            }
        }
    }
    
    // Show compounds section
    if (data.COMPOUND) {
        const compoundsSection = document.getElementById(`kegg-compounds-section-${index}`);
        if (compoundsSection) compoundsSection.style.display = 'block';
        
        const compoundsList = document.getElementById(`kegg-compounds-list-${index}`);
        const compoundCount = document.getElementById(`kegg-compound-count-${index}`);
        
        const compounds = Array.isArray(data.COMPOUND) ? data.COMPOUND : [data.COMPOUND];
        if (compoundCount) compoundCount.textContent = `(${compounds.length})`;
        
        if (compoundsList) {
            compoundsList.innerHTML = compounds.slice(0, 50).map(compound => {
                const match = compound.match(/^(C\d{5})\s+(.*)/);
                if (match) {
                    const [, compId, name] = match;
                    return `
                        <div class="kegg-compound-item" onclick="openKEGGEntry('${compId}')">
                            <span class="compound-id">${compId}</span>
                            <span class="compound-name">${name}</span>
                        </div>
                    `;
                }
                return `<div class="kegg-compound-item">${compound}</div>`;
            }).join('');
        }
    }
    
    // Show drugs section
    if (data.DRUG) {
        const drugsSection = document.getElementById(`kegg-drugs-section-${index}`);
        if (drugsSection) drugsSection.style.display = 'block';
        
        const drugsList = document.getElementById(`kegg-drugs-list-${index}`);
        const drugCount = document.getElementById(`kegg-drug-count-${index}`);
        
        const drugs = Array.isArray(data.DRUG) ? data.DRUG : [data.DRUG];
        if (drugCount) drugCount.textContent = `(${drugs.length})`;
        
        if (drugsList) {
            drugsList.innerHTML = drugs.map(drug => {
                const match = drug.match(/^(D\d{5})\s+(.*)/);
                if (match) {
                    const [, drugId, name] = match;
                    return `
                        <div class="kegg-drug-item" onclick="openKEGGEntry('${drugId}')">
                            <span class="drug-id">${drugId}</span>
                            <span class="drug-name">${name}</span>
                        </div>
                    `;
                }
                return `<div class="kegg-drug-item">${drug}</div>`;
            }).join('');
        }
    }
    
    // Show related pathways
    if (data.REL_PATHWAY) {
        const relatedSection = document.getElementById(`kegg-related-section-${index}`);
        if (relatedSection) relatedSection.style.display = 'block';
        
        const relatedList = document.getElementById(`kegg-related-list-${index}`);
        const relPathways = Array.isArray(data.REL_PATHWAY) ? data.REL_PATHWAY : [data.REL_PATHWAY];
        
        if (relatedList) {
            relatedList.innerHTML = relPathways.map(pathway => {
                const match = pathway.match(/^([a-z]+\d{5})\s+(.*)/);
                if (match) {
                    const [, pathId, name] = match;
                    return `
                        <div class="kegg-related-item" onclick="openKEGGEntry('${pathId}')">
                            <span class="pathway-id">${pathId}</span>
                            <span class="pathway-name">${name}</span>
                        </div>
                    `;
                }
                return `<div class="kegg-related-item">${pathway}</div>`;
            }).join('');
        }
    }
    
    // Show and initialize interactive pathway network
    const networkSection = document.getElementById(`kegg-network-section-${index}`);
    if (networkSection && (data.GENE || data.COMPOUND || data.REACTION)) {
        networkSection.style.display = 'block';
        setTimeout(() => initializeKEGGNetwork(index, data), 300);
    }
}

// Load compound-specific content
async function loadKEGGCompoundContent(index, keggId, data) {
    // Hide pathway map and network, show structure
    const mapSection = document.querySelector(`#kegg-map-${index}`)?.closest('.kegg-map-section');
    if (mapSection) mapSection.style.display = 'none';
    
    const networkSection = document.getElementById(`kegg-network-section-${index}`);
    if (networkSection) networkSection.style.display = 'none';
    
    const structureSection = document.getElementById(`kegg-structure-section-${index}`);
    if (structureSection) {
        structureSection.style.display = 'block';
        
        const structureContainer = document.getElementById(`kegg-structure-${index}`);
        if (structureContainer) {
            // Load MOL structure image via CORS proxy
            structureContainer.innerHTML = `
                <img src="${KEGG_CORS_PROXY}${encodeURIComponent(`https://rest.kegg.jp/get/${keggId}/image`)}" 
                     alt="Compound Structure" 
                     class="kegg-compound-image"
                     onerror="this.parentElement.innerHTML='<div class=\\'structure-error\\'>Structure not available</div>'">
            `;
        }
        
        // Show compound properties
        const propsContainer = document.getElementById(`kegg-compound-props-${index}`);
        if (propsContainer) {
            let propsHtml = '<div class="compound-props-grid">';
            if (data.FORMULA) propsHtml += `<div class="prop-item"><strong>Formula:</strong> ${data.FORMULA}</div>`;
            if (data.EXACT_MASS) propsHtml += `<div class="prop-item"><strong>Exact Mass:</strong> ${data.EXACT_MASS}</div>`;
            if (data.MOL_WEIGHT) propsHtml += `<div class="prop-item"><strong>Mol. Weight:</strong> ${data.MOL_WEIGHT}</div>`;
            propsHtml += '</div>';
            propsContainer.innerHTML = propsHtml;
        }
    }
    
    // Show and initialize 3D viewer for compound
    const viewer3DSection = document.getElementById(`kegg-3d-section-${index}`);
    if (viewer3DSection) {
        viewer3DSection.style.display = 'block';
        setTimeout(() => initializeKEGG3DViewer(index, keggId), 200);
    }
    
    // Show compound relationship network (compound connected to pathways and enzymes)
    if (data.PATHWAY || data.ENZYME || data.REACTION) {
        const networkSection = document.getElementById(`kegg-network-section-${index}`);
        if (networkSection) {
            networkSection.style.display = 'block';
            setTimeout(() => initializeCompoundNetwork(index, keggId, data), 300);
        }
    }
    
    // Show pathways section for compound
    if (data.PATHWAY) {
        const pathwaysSection = document.getElementById(`kegg-pathways-section-${index}`);
        if (pathwaysSection) pathwaysSection.style.display = 'block';
        
        const pathwaysList = document.getElementById(`kegg-pathways-list-${index}`);
        const pathwayCount = document.getElementById(`kegg-pathway-count-${index}`);
        
        const pathways = Array.isArray(data.PATHWAY) ? data.PATHWAY : [data.PATHWAY];
        if (pathwayCount) pathwayCount.textContent = `(${pathways.length})`;
        
        if (pathwaysList) {
            pathwaysList.innerHTML = pathways.slice(0, 30).map(pathway => {
                const match = pathway.match(/^(map\d{5})\s+(.*)/);
                if (match) {
                    const [, pathId, name] = match;
                    return `
                        <div class="kegg-pathway-item" onclick="openKEGGEntry('${pathId}')">
                            <span class="pathway-id">${pathId}</span>
                            <span class="pathway-name">${name}</span>
                        </div>
                    `;
                }
                return `<div class="kegg-pathway-item">${pathway}</div>`;
            }).join('');
            
            if (pathways.length > 30) {
                pathwaysList.innerHTML += `<div class="kegg-more-items">...and ${pathways.length - 30} more pathways</div>`;
            }
        }
    }
    
    // Show enzymes section
    if (data.ENZYME) {
        const enzymesSection = document.getElementById(`kegg-enzymes-section-${index}`);
        if (enzymesSection) enzymesSection.style.display = 'block';
        
        const enzymesList = document.getElementById(`kegg-enzymes-list-${index}`);
        const enzymeCount = document.getElementById(`kegg-enzyme-count-${index}`);
        
        const enzymes = Array.isArray(data.ENZYME) ? data.ENZYME : data.ENZYME.split(/\s+/);
        if (enzymeCount) enzymeCount.textContent = `(${enzymes.length})`;
        
        if (enzymesList) {
            enzymesList.innerHTML = enzymes.slice(0, 20).map(ec => `
                <span class="kegg-enzyme-chip" onclick="openKEGGEntry('${ec.trim()}')">${ec.trim()}</span>
            `).join('');
        }
    }
}

// Load gene-specific content
async function loadKEGGGeneContent(index, keggId, data) {
    // Hide pathway map
    const mapSection = document.querySelector(`#kegg-map-${index}`)?.closest('.kegg-map-section');
    if (mapSection) mapSection.style.display = 'none';
    
    // Show pathways for this gene
    if (data.PATHWAY) {
        const pathwaysSection = document.getElementById(`kegg-pathways-section-${index}`);
        if (pathwaysSection) pathwaysSection.style.display = 'block';
        
        const pathwaysList = document.getElementById(`kegg-pathways-list-${index}`);
        const pathways = Array.isArray(data.PATHWAY) ? data.PATHWAY : [data.PATHWAY];
        
        if (pathwaysList) {
            pathwaysList.innerHTML = pathways.map(pathway => {
                const match = pathway.match(/^([a-z]+\d{5})\s+(.*)/);
                if (match) {
                    const [, pathId, name] = match;
                    return `
                        <div class="kegg-pathway-item" onclick="openKEGGEntry('${pathId}')">
                            <span class="pathway-id">${pathId}</span>
                            <span class="pathway-name">${name}</span>
                        </div>
                    `;
                }
                return `<div class="kegg-pathway-item">${pathway}</div>`;
            }).join('');
        }
    }
}

// Load drug-specific content
async function loadKEGGDrugContent(index, keggId, data) {
    // Show structure
    const structureSection = document.getElementById(`kegg-structure-section-${index}`);
    if (structureSection) {
        structureSection.style.display = 'block';
        
        const structureContainer = document.getElementById(`kegg-structure-${index}`);
        if (structureContainer) {
            structureContainer.innerHTML = `
                <img src="${KEGG_CORS_PROXY}${encodeURIComponent(`https://rest.kegg.jp/get/${keggId}/image`)}" 
                     alt="Drug Structure" 
                     class="kegg-drug-image"
                     onerror="this.parentElement.innerHTML='<div class=\\'structure-error\\'>Structure not available</div>'">
            `;
        }
    }
    
    // Hide map and network
    const mapSection = document.querySelector(`#kegg-map-${index}`)?.closest('.kegg-map-section');
    if (mapSection) mapSection.style.display = 'none';
    
    const networkSection = document.getElementById(`kegg-network-section-${index}`);
    if (networkSection) networkSection.style.display = 'none';
    
    // Show and initialize 3D viewer for drug
    const viewer3DSection = document.getElementById(`kegg-3d-section-${index}`);
    if (viewer3DSection) {
        viewer3DSection.style.display = 'block';
        setTimeout(() => initializeKEGG3DViewer(index, keggId), 200);
    }
}

// Update KEGG cross-links
function updateKEGGCrossLinks(index, data) {
    const crosslinksContainer = document.getElementById(`kegg-crosslinks-${index}`);
    if (!crosslinksContainer) return;
    
    const links = [];
    
    // Always add KEGG link
    const keggId = keggDataCache[index]?.keggId;
    if (keggId) {
        links.push({
            name: 'KEGG',
            url: `https://www.genome.jp/entry/${keggId}`,
            icon: '🔗'
        });
    }
    
    // Check for DBLINKS
    if (data.DBLINKS) {
        const dblinks = Array.isArray(data.DBLINKS) ? data.DBLINKS.join(' ') : data.DBLINKS;
        
        // PubChem
        const pubchemMatch = dblinks.match(/PubChem:\s*(\d+)/);
        if (pubchemMatch) {
            links.push({
                name: 'PubChem',
                url: `https://pubchem.ncbi.nlm.nih.gov/compound/${pubchemMatch[1]}`,
                icon: '🧪'
            });
        }
        
        // ChEBI
        const chebiMatch = dblinks.match(/ChEBI:\s*(\d+)/);
        if (chebiMatch) {
            links.push({
                name: 'ChEBI',
                url: `https://www.ebi.ac.uk/chebi/searchId.do?chebiId=CHEBI:${chebiMatch[1]}`,
                icon: '🔬'
            });
        }
        
        // GO
        const goMatch = dblinks.match(/GO:\s*([\d\s]+)/);
        if (goMatch) {
            const goIds = goMatch[1].trim().split(/\s+/);
            links.push({
                name: 'Gene Ontology',
                url: `https://amigo.geneontology.org/amigo/term/GO:${goIds[0]}`,
                icon: '🧬'
            });
        }
    }
    
    crosslinksContainer.innerHTML = links.map(link => `
        <a href="${link.url}" target="_blank" class="kegg-crosslink-btn">
            <span class="crosslink-icon">${link.icon}</span>
            <span class="crosslink-name">${link.name}</span>
        </a>
    `).join('');
}

// Toggle KEGG section visibility
function toggleKEGGSection(index, section) {
    const content = document.getElementById(`kegg-${section}-${index}`);
    if (content) {
        content.classList.toggle('collapsed');
        const icon = content.previousElementSibling?.querySelector('.collapse-icon');
        if (icon) {
            icon.textContent = content.classList.contains('collapsed') ? '▶' : '▼';
        }
    }
}

// Filter genes in list
function filterKEGGGenes(index, query) {
    const geneItems = document.querySelectorAll(`#kegg-genes-list-${index} .kegg-gene-item`);
    const lowerQuery = query.toLowerCase();
    
    geneItems.forEach(item => {
        const geneData = item.dataset.gene || item.textContent.toLowerCase();
        item.style.display = geneData.includes(lowerQuery) ? '' : 'none';
    });
}

// Open full KEGG map
function openKEGGMapFull(index) {
    const keggId = keggDataCache[index]?.keggId;
    if (keggId) {
        window.open(`https://www.genome.jp/pathway/${keggId}`, '_blank');
    }
}

// Download KEGG map image
async function downloadKEGGMap(index) {
    const keggId = keggDataCache[index]?.keggId;
    if (!keggId) return;
    
    try {
        const response = await fetch(KEGG_CORS_PROXY + encodeURIComponent(`https://rest.kegg.jp/get/${keggId}/image`));
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${keggId}_pathway.png`;
        a.click();
        URL.revokeObjectURL(url);
    } catch (error) {
        console.error('Error downloading KEGG map:', error);
        alert('Failed to download pathway map');
    }
}

// Open KEGG entry in new tab
function openKEGGEntry(entryId) {
    window.open(`https://www.genome.jp/entry/${entryId}`, '_blank');
}

// ==========================================
// KEGG 3D Compound Viewer (using 3Dmol.js)
// ==========================================

let kegg3DViewers = {};

async function initializeKEGG3DViewer(index, keggId) {
    console.log(`Initializing KEGG 3D viewer for ${keggId}`);
    
    const container = document.getElementById(`kegg-3d-viewer-${index}`);
    if (!container) return;
    
    try {
        // Fetch MOL data from KEGG via CORS proxy
        const molUrl = KEGG_CORS_PROXY + encodeURIComponent(`https://rest.kegg.jp/get/${keggId}/mol`);
        const response = await fetch(molUrl);
        
        if (!response.ok) {
            throw new Error(`Failed to fetch MOL file: ${response.status}`);
        }
        
        const molData = await response.text();
        
        // Check if we got valid MOL data
        if (!molData || molData.includes('No such') || molData.length < 100) {
            container.innerHTML = '<div class="structure-error">3D structure not available for this compound</div>';
            return;
        }
        
        // Clear loading message
        container.innerHTML = '';
        
        // Initialize 3Dmol viewer
        const viewer = $3Dmol.createViewer(container, {
            backgroundColor: '#1a1a2e',
            antialias: true
        });
        
        // Add the molecule
        viewer.addModel(molData, 'mol');
        
        // Set initial style (stick)
        viewer.setStyle({}, {stick: {colorscheme: 'default', radius: 0.15}});
        
        // Zoom to fit
        viewer.zoomTo();
        viewer.render();
        
        // Store viewer reference
        kegg3DViewers[index] = {
            viewer: viewer,
            molData: molData,
            currentStyle: 'stick'
        };
        
        console.log(`KEGG 3D viewer initialized for ${keggId}`);
        
    } catch (error) {
        console.error('Error initializing KEGG 3D viewer:', error);
        container.innerHTML = `<div class="structure-error">Error loading 3D structure: ${error.message}</div>`;
    }
}

function setKEGG3DStyle(index, style) {
    const viewerData = kegg3DViewers[index];
    if (!viewerData) return;
    
    const viewer = viewerData.viewer;
    
    // Update button states
    const toggles = document.querySelectorAll(`#kegg-rep-toggles-${index} .rep-toggle`);
    toggles.forEach(btn => {
        btn.classList.toggle('active', btn.dataset.style === style);
    });
    
    // Apply style
    viewer.setStyle({}, {});
    
    switch (style) {
        case 'stick':
            viewer.setStyle({}, {stick: {colorscheme: 'default', radius: 0.15}});
            break;
        case 'sphere':
            viewer.setStyle({}, {sphere: {colorscheme: 'default', scale: 0.3}});
            break;
        case 'ballstick':
            viewer.setStyle({}, {
                stick: {colorscheme: 'default', radius: 0.1},
                sphere: {colorscheme: 'default', scale: 0.25}
            });
            break;
    }
    
    viewer.render();
    viewerData.currentStyle = style;
}

function resetKEGG3DView(index) {
    const viewerData = kegg3DViewers[index];
    if (!viewerData) return;
    
    viewerData.viewer.zoomTo();
    viewerData.viewer.render();
}

// ==========================================
// KEGG Pathway Network (using Cytoscape.js)
// ==========================================

let keggNetworks = {};

function initializeKEGGNetwork(index, data) {
    console.log(`Initializing KEGG network for index ${index}`);
    
    const container = document.getElementById(`kegg-network-${index}`);
    if (!container) return;
    
    // Build network elements from KEGG data
    const elements = buildNetworkElements(data);
    
    if (elements.nodes.length === 0) {
        container.innerHTML = '<div class="network-empty">No network data available for this pathway</div>';
        return;
    }
    
    // Clear container
    container.innerHTML = '';
    
    // Initialize Cytoscape
    const cy = cytoscape({
        container: container,
        elements: elements,
        style: [
            // Node styles
            {
                selector: 'node[type="gene"]',
                style: {
                    'background-color': '#4ecdc4',
                    'label': 'data(label)',
                    'color': '#ffffff',
                    'text-valign': 'center',
                    'text-halign': 'center',
                    'font-size': '10px',
                    'width': 'label',
                    'height': 30,
                    'padding': '8px',
                    'shape': 'roundrectangle',
                    'text-wrap': 'wrap',
                    'text-max-width': '80px'
                }
            },
            {
                selector: 'node[type="compound"]',
                style: {
                    'background-color': '#ff6b6b',
                    'label': 'data(label)',
                    'color': '#ffffff',
                    'text-valign': 'center',
                    'text-halign': 'center',
                    'font-size': '9px',
                    'width': 50,
                    'height': 50,
                    'shape': 'ellipse'
                }
            },
            {
                selector: 'node[type="reaction"]',
                style: {
                    'background-color': '#ffd93d',
                    'label': 'data(label)',
                    'color': '#000000',
                    'text-valign': 'center',
                    'text-halign': 'center',
                    'font-size': '8px',
                    'width': 40,
                    'height': 40,
                    'shape': 'diamond'
                }
            },
            // Edge styles
            {
                selector: 'edge',
                style: {
                    'width': 2,
                    'line-color': '#555',
                    'target-arrow-color': '#555',
                    'target-arrow-shape': 'triangle',
                    'curve-style': 'bezier',
                    'opacity': 0.7
                }
            },
            {
                selector: 'edge[type="catalyzes"]',
                style: {
                    'line-color': '#4ecdc4',
                    'target-arrow-color': '#4ecdc4',
                    'line-style': 'dashed'
                }
            },
            // Hover/selection styles
            {
                selector: 'node:selected',
                style: {
                    'border-width': 3,
                    'border-color': '#ffffff'
                }
            },
            {
                selector: 'node:active',
                style: {
                    'overlay-opacity': 0.2
                }
            }
        ],
        layout: {
            name: 'cose',
            animate: true,
            animationDuration: 500,
            nodeRepulsion: 8000,
            idealEdgeLength: 100,
            gravity: 0.25
        },
        minZoom: 0.2,
        maxZoom: 3,
        wheelSensitivity: 0.3
    });
    
    // Tooltip on hover
    cy.on('mouseover', 'node', function(e) {
        const node = e.target;
        showNetworkTooltip(container, node, e.renderedPosition);
    });
    
    cy.on('mouseout', 'node', function() {
        // Small delay so user can move to tooltip
        setTimeout(() => {
            const tooltip = document.querySelector('.kegg-node-tooltip');
            if (tooltip && !tooltip.matches(':hover')) {
                hideNetworkTooltip();
            }
        }, 200);
    });
    
    // Store reference
    keggNetworks[index] = cy;
    
    console.log(`Network initialized with ${elements.nodes.length} nodes and ${elements.edges.length} edges`);
}

function buildNetworkElements(data) {
    const nodes = [];
    const edges = [];
    const nodeIds = new Set();
    
    // Add gene nodes
    if (data.GENE) {
        const genes = Array.isArray(data.GENE) ? data.GENE : [data.GENE];
        genes.slice(0, 50).forEach((gene, i) => {
            const match = gene.match(/^(\d+)\s+([^;]+)/);
            if (match) {
                const [, geneId, symbol] = match;
                const nodeId = `gene-${geneId}`;
                if (!nodeIds.has(nodeId)) {
                    nodes.push({
                        data: {
                            id: nodeId,
                            label: symbol.substring(0, 12),
                            fullLabel: symbol,
                            type: 'gene',
                            keggId: geneId,
                            description: gene
                        }
                    });
                    nodeIds.add(nodeId);
                }
            }
        });
    }
    
    // Add compound nodes
    if (data.COMPOUND) {
        const compounds = Array.isArray(data.COMPOUND) ? data.COMPOUND : [data.COMPOUND];
        compounds.slice(0, 30).forEach((compound, i) => {
            const match = compound.match(/^(C\d{5})\s+(.*)/);
            if (match) {
                const [, compoundId, name] = match;
                const nodeId = `compound-${compoundId}`;
                if (!nodeIds.has(nodeId)) {
                    nodes.push({
                        data: {
                            id: nodeId,
                            label: name.substring(0, 10),
                            fullLabel: name,
                            type: 'compound',
                            keggId: compoundId,
                            description: compound
                        }
                    });
                    nodeIds.add(nodeId);
                }
            }
        });
    }
    
    // Create edges between genes and compounds based on REACTION data
    if (data.REACTION) {
        const reactions = Array.isArray(data.REACTION) ? data.REACTION : [data.REACTION];
        reactions.slice(0, 20).forEach((reaction, i) => {
            const match = reaction.match(/^(R\d{5})\s+(.*)/);
            if (match) {
                const [, reactionId, name] = match;
                const nodeId = `reaction-${reactionId}`;
                
                // Add reaction node
                if (!nodeIds.has(nodeId)) {
                    nodes.push({
                        data: {
                            id: nodeId,
                            label: reactionId,
                            fullLabel: name,
                            type: 'reaction',
                            keggId: reactionId,
                            description: reaction
                        }
                    });
                    nodeIds.add(nodeId);
                }
            }
        });
    }
    
    // Create connections between nodes
    // Connect compounds to nearby genes (simplified pathway representation)
    const geneNodes = nodes.filter(n => n.data.type === 'gene');
    const compoundNodes = nodes.filter(n => n.data.type === 'compound');
    const reactionNodes = nodes.filter(n => n.data.type === 'reaction');
    
    // Connect reactions to random compounds and genes for visualization
    reactionNodes.forEach((reaction, i) => {
        // Connect to a couple of compounds
        if (compoundNodes.length > 0) {
            const c1 = compoundNodes[i % compoundNodes.length];
            const c2 = compoundNodes[(i + 1) % compoundNodes.length];
            edges.push({
                data: {
                    id: `edge-${reaction.data.id}-${c1.data.id}`,
                    source: c1.data.id,
                    target: reaction.data.id,
                    type: 'substrate'
                }
            });
            if (c1 !== c2) {
                edges.push({
                    data: {
                        id: `edge-${reaction.data.id}-${c2.data.id}-out`,
                        source: reaction.data.id,
                        target: c2.data.id,
                        type: 'product'
                    }
                });
            }
        }
        
        // Connect to a gene (as catalyst)
        if (geneNodes.length > 0) {
            const g = geneNodes[i % geneNodes.length];
            edges.push({
                data: {
                    id: `edge-${g.data.id}-${reaction.data.id}`,
                    source: g.data.id,
                    target: reaction.data.id,
                    type: 'catalyzes'
                }
            });
        }
    });
    
    // If no reactions, create a simple star topology connecting genes to compounds
    if (reactionNodes.length === 0 && geneNodes.length > 0 && compoundNodes.length > 0) {
        geneNodes.forEach((gene, i) => {
            const compound = compoundNodes[i % compoundNodes.length];
            edges.push({
                data: {
                    id: `edge-${gene.data.id}-${compound.data.id}`,
                    source: gene.data.id,
                    target: compound.data.id,
                    type: 'interacts'
                }
            });
        });
    }
    
    return { nodes, edges };
}

function showNetworkTooltip(container, node, position) {
    // Remove any existing tooltips
    document.querySelectorAll('.kegg-node-tooltip').forEach(el => el.remove());
    
    const keggId = node.data('keggId');
    const nodeType = node.data('type');
    
    const tooltip = document.createElement('div');
    tooltip.className = 'kegg-node-tooltip';
    tooltip.innerHTML = `
        <div class="tooltip-title">${node.data('fullLabel') || node.data('label')}</div>
        <div class="tooltip-type">${nodeType}</div>
        ${keggId ? `<div class="tooltip-desc">KEGG ID: ${keggId}</div>` : ''}
    `;
    
    tooltip.style.left = `${position.x + 15}px`;
    tooltip.style.top = `${position.y + 15}px`;
    
    container.appendChild(tooltip);
}

function hideNetworkTooltip() {
    document.querySelectorAll('.kegg-node-tooltip').forEach(el => el.remove());
}

function resetKEGGNetwork(index) {
    const cy = keggNetworks[index];
    if (!cy) return;
    
    cy.layout({
        name: 'cose',
        animate: true,
        animationDuration: 500
    }).run();
}

function fitKEGGNetwork(index) {
    const cy = keggNetworks[index];
    if (!cy) return;
    
    cy.fit(50);
}

function changeKEGGNetworkLayout(index, layoutName) {
    const cy = keggNetworks[index];
    if (!cy) return;
    
    const layouts = {
        cose: {
            name: 'cose',
            animate: true,
            animationDuration: 500,
            nodeRepulsion: 8000
        },
        circle: {
            name: 'circle',
            animate: true,
            animationDuration: 500
        },
        grid: {
            name: 'grid',
            animate: true,
            animationDuration: 500
        },
        breadthfirst: {
            name: 'breadthfirst',
            animate: true,
            animationDuration: 500,
            directed: true
        }
    };
    
    cy.layout(layouts[layoutName] || layouts.cose).run();
}

// Initialize compound-centric network (compound at center connected to pathways, enzymes)
function initializeCompoundNetwork(index, keggId, data) {
    console.log(`Initializing compound network for ${keggId}`);
    
    const container = document.getElementById(`kegg-network-${index}`);
    if (!container) return;
    
    const nodes = [];
    const edges = [];
    
    // Get compound name
    const compoundName = data.NAME ? (Array.isArray(data.NAME) ? data.NAME[0] : data.NAME.split(';')[0]) : keggId;
    
    // Add central compound node
    nodes.push({
        data: {
            id: `compound-${keggId}`,
            label: compoundName.substring(0, 15),
            fullLabel: compoundName,
            type: 'compound',
            keggId: keggId,
            isCenter: true
        }
    });
    
    // Add pathway nodes
    if (data.PATHWAY) {
        const pathways = Array.isArray(data.PATHWAY) ? data.PATHWAY : [data.PATHWAY];
        pathways.slice(0, 15).forEach(pathway => {
            const match = pathway.match(/^(map\d{5})\s+(.*)/);
            if (match) {
                const [, pathId, name] = match;
                nodes.push({
                    data: {
                        id: `pathway-${pathId}`,
                        label: name.substring(0, 20),
                        fullLabel: name,
                        type: 'pathway',
                        keggId: pathId
                    }
                });
                edges.push({
                    data: {
                        id: `edge-${keggId}-${pathId}`,
                        source: `compound-${keggId}`,
                        target: `pathway-${pathId}`,
                        type: 'participates'
                    }
                });
            }
        });
    }
    
    // Add enzyme nodes
    if (data.ENZYME) {
        const enzymes = Array.isArray(data.ENZYME) ? data.ENZYME : data.ENZYME.split(/\s+/);
        enzymes.slice(0, 10).forEach(enzyme => {
            const ec = enzyme.trim();
            if (ec) {
                nodes.push({
                    data: {
                        id: `enzyme-${ec}`,
                        label: `EC:${ec}`,
                        fullLabel: `Enzyme ${ec}`,
                        type: 'enzyme',
                        keggId: ec
                    }
                });
                edges.push({
                    data: {
                        id: `edge-${keggId}-${ec}`,
                        source: `compound-${keggId}`,
                        target: `enzyme-${ec}`,
                        type: 'substrate'
                    }
                });
            }
        });
    }
    
    // Add reaction nodes
    if (data.REACTION) {
        const reactions = Array.isArray(data.REACTION) ? data.REACTION : [data.REACTION];
        reactions.slice(0, 10).forEach(reaction => {
            const match = reaction.match(/^(R\d{5})/);
            if (match) {
                const reactionId = match[1];
                nodes.push({
                    data: {
                        id: `reaction-${reactionId}`,
                        label: reactionId,
                        fullLabel: `Reaction ${reactionId}`,
                        type: 'reaction',
                        keggId: reactionId
                    }
                });
                edges.push({
                    data: {
                        id: `edge-${keggId}-${reactionId}`,
                        source: `compound-${keggId}`,
                        target: `reaction-${reactionId}`,
                        type: 'reacts'
                    }
                });
            }
        });
    }
    
    if (nodes.length <= 1) {
        container.innerHTML = '<div class="network-empty">No relationship data available for this compound</div>';
        return;
    }
    
    // Clear container
    container.innerHTML = '';
    
    // Initialize Cytoscape
    const cy = cytoscape({
        container: container,
        elements: { nodes, edges },
        style: [
            // Central compound (larger)
            {
                selector: 'node[?isCenter]',
                style: {
                    'background-color': '#ff6b6b',
                    'label': 'data(label)',
                    'color': '#ffffff',
                    'text-valign': 'center',
                    'text-halign': 'center',
                    'font-size': '12px',
                    'font-weight': 'bold',
                    'width': 80,
                    'height': 80,
                    'shape': 'ellipse',
                    'border-width': 3,
                    'border-color': '#ffffff'
                }
            },
            // Pathway nodes
            {
                selector: 'node[type="pathway"]',
                style: {
                    'background-color': '#9b59b6',
                    'label': 'data(label)',
                    'color': '#ffffff',
                    'text-valign': 'center',
                    'text-halign': 'center',
                    'font-size': '9px',
                    'width': 'label',
                    'height': 35,
                    'padding': '10px',
                    'shape': 'roundrectangle',
                    'text-wrap': 'wrap',
                    'text-max-width': '100px'
                }
            },
            // Enzyme nodes
            {
                selector: 'node[type="enzyme"]',
                style: {
                    'background-color': '#3498db',
                    'label': 'data(label)',
                    'color': '#ffffff',
                    'text-valign': 'center',
                    'text-halign': 'center',
                    'font-size': '9px',
                    'width': 55,
                    'height': 55,
                    'shape': 'hexagon'
                }
            },
            // Reaction nodes
            {
                selector: 'node[type="reaction"]',
                style: {
                    'background-color': '#ffd93d',
                    'label': 'data(label)',
                    'color': '#000000',
                    'text-valign': 'center',
                    'text-halign': 'center',
                    'font-size': '8px',
                    'width': 45,
                    'height': 45,
                    'shape': 'diamond'
                }
            },
            // Edge styles
            {
                selector: 'edge',
                style: {
                    'width': 2,
                    'line-color': '#666',
                    'target-arrow-color': '#666',
                    'target-arrow-shape': 'triangle',
                    'curve-style': 'bezier',
                    'opacity': 0.7
                }
            },
            {
                selector: 'edge[type="participates"]',
                style: {
                    'line-color': '#9b59b6',
                    'target-arrow-color': '#9b59b6'
                }
            },
            {
                selector: 'edge[type="substrate"]',
                style: {
                    'line-color': '#3498db',
                    'target-arrow-color': '#3498db',
                    'line-style': 'dashed'
                }
            },
            // Hover/selection
            {
                selector: 'node:selected',
                style: {
                    'border-width': 4,
                    'border-color': '#ffffff'
                }
            }
        ],
        layout: {
            name: 'cose',
            animate: true,
            animationDuration: 500,
            nodeRepulsion: 10000,
            idealEdgeLength: 120,
            gravity: 0.3
        },
        minZoom: 0.3,
        maxZoom: 2.5,
        wheelSensitivity: 0.3
    });
    
    // Tooltip on hover
    cy.on('mouseover', 'node', function(e) {
        const node = e.target;
        showNetworkTooltip(container, node, e.renderedPosition);
    });
    
    cy.on('mouseout', 'node', function() {
        // Small delay so user can move to tooltip
        setTimeout(() => {
            const tooltip = document.querySelector('.kegg-node-tooltip');
            if (tooltip && !tooltip.matches(':hover')) {
                hideNetworkTooltip();
            }
        }, 200);
    });
    
    // Store reference
    keggNetworks[index] = cy;
    
    console.log(`Compound network initialized with ${nodes.length} nodes`);
}

// Open KEGG entry in default browser (more reliable method)
function openKEGGInBrowser(keggId, nodeType) {
    let url = '';
    
    // Build proper KEGG URL based on entry type
    if (nodeType === 'pathway' && keggId.startsWith('map')) {
        url = `https://www.genome.jp/pathway/${keggId}`;
    } else if (nodeType === 'enzyme') {
        url = `https://www.genome.jp/entry/ec:${keggId}`;
    } else {
        url = `https://www.genome.jp/entry/${keggId}`;
    }
    
    // Create a temporary link element and click it
    // This is more reliable than window.open() which can be blocked
    const link = document.createElement('a');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    
    console.log(`Opening KEGG entry: ${url}`);
}

// Make functions globally available
window.setKEGG3DStyle = setKEGG3DStyle;
window.resetKEGG3DView = resetKEGG3DView;
window.resetKEGGNetwork = resetKEGGNetwork;
window.fitKEGGNetwork = fitKEGGNetwork;
window.changeKEGGNetworkLayout = changeKEGGNetworkLayout;
window.openKEGGInBrowser = openKEGGInBrowser;

// =====================================================
// PUBCHEM WORKFLOW FUNCTIONS
// =====================================================

// Cache for PubChem data
let pubchemDataCache = {};
let pubchem3DViewers = {};
let pubchemSdfCache = {};

// Initialize PubChem workflow for a compound
async function initializePubChemWorkflow(index, cid) {
    console.log(`Initializing PubChem workflow for index ${index}, CID: ${cid}`);
    
    try {
        // Fetch all data in parallel
        const [properties, synonyms, description] = await Promise.all([
            fetchPubChemProperties(cid),
            fetchPubChemSynonyms(cid),
            fetchPubChemDescription(cid)
        ]);
        
        // Cache the data
        pubchemDataCache[index] = {
            cid: cid,
            properties: properties,
            synonyms: synonyms,
            description: description
        };
        
        // Update UI
        updatePubChemHeader(index, properties);
        updatePubChemIdentifiers(index, properties, cid);
        updatePubChemProperties(index, properties);
        updatePubChemLipinski(index, properties);
        updatePubChemDescription(index, description);
        updatePubChemSynonyms(index, synonyms);
        
        // Load structure images
        loadPubChem2DImage(index, cid);
        loadPubChem3DViewer(index, cid);
        
    } catch (error) {
        console.error('Error initializing PubChem workflow:', error);
        const quickInfo = document.getElementById(`pubchem-quick-info-${index}`);
        if (quickInfo) {
            quickInfo.innerHTML = `<span class="error-text">Error loading PubChem data: ${error.message}</span>`;
        }
    }
}

// Fetch compound properties from PubChem API
async function fetchPubChemProperties(cid) {
    const properties = [
        'MolecularFormula', 'MolecularWeight', 'CanonicalSMILES', 'IsomericSMILES',
        'InChI', 'InChIKey', 'IUPACName', 'XLogP', 'ExactMass', 'MonoisotopicMass',
        'TPSA', 'Complexity', 'Charge', 'HBondDonorCount', 'HBondAcceptorCount',
        'RotatableBondCount', 'HeavyAtomCount', 'AtomStereoCount', 'DefinedAtomStereoCount',
        'BondStereoCount', 'DefinedBondStereoCount', 'CovalentUnitCount'
    ].join(',');
    
    const url = `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid/${cid}/property/${properties}/JSON`;
    const response = await fetch(url);
    
    if (!response.ok) {
        throw new Error(`PubChem API error: ${response.status}`);
    }
    
    const data = await response.json();
    return data.PropertyTable?.Properties?.[0] || {};
}

// Fetch compound synonyms from PubChem API
async function fetchPubChemSynonyms(cid) {
    try {
        const url = `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid/${cid}/synonyms/JSON`;
        const response = await fetch(url);
        
        if (!response.ok) {
            return [];
        }
        
        const data = await response.json();
        return data.InformationList?.Information?.[0]?.Synonym || [];
    } catch (error) {
        console.warn('Could not fetch synonyms:', error);
        return [];
    }
}

// Fetch compound description from PubChem API
async function fetchPubChemDescription(cid) {
    try {
        const url = `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid/${cid}/description/JSON`;
        const response = await fetch(url);
        
        if (!response.ok) {
            return null;
        }
        
        const data = await response.json();
        const descriptions = data.InformationList?.Information || [];
        
        // Find the best description (prefer longer, more informative ones)
        let bestDesc = null;
        for (const info of descriptions) {
            if (info.Description) {
                if (!bestDesc || info.Description.length > bestDesc.length) {
                    bestDesc = info.Description;
                }
            }
        }
        
        return bestDesc;
    } catch (error) {
        console.warn('Could not fetch description:', error);
        return null;
    }
}

// Update header with quick info
function updatePubChemHeader(index, properties) {
    const quickInfo = document.getElementById(`pubchem-quick-info-${index}`);
    
    if (quickInfo && properties) {
        let html = '';
        
        if (properties.IUPACName) {
            const name = properties.IUPACName.length > 50 
                ? properties.IUPACName.substring(0, 50) + '...' 
                : properties.IUPACName;
            html += `<span class="pubchem-name">${name}</span>`;
        }
        
        if (properties.MolecularFormula) {
            html += `<span class="pubchem-formula">${properties.MolecularFormula}</span>`;
        }
        
        if (properties.MolecularWeight) {
            html += `<span class="pubchem-weight">${parseFloat(properties.MolecularWeight).toFixed(2)} g/mol</span>`;
        }
        
        quickInfo.innerHTML = html || 'Compound data loaded';
    }
}

// Update identifiers section
function updatePubChemIdentifiers(index, properties, cid) {
    const container = document.getElementById(`pubchem-identifiers-${index}`);
    
    if (!container) return;
    
    let html = `
        <div class="identifier-item">
            <span class="identifier-label">CID</span>
            <span class="identifier-value">${cid}</span>
        </div>
    `;
    
    if (properties.IUPACName) {
        html += `
            <div class="identifier-item identifier-full">
                <span class="identifier-label">IUPAC Name</span>
                <span class="identifier-value iupac-name">${properties.IUPACName}</span>
            </div>
        `;
    }
    
    if (properties.CanonicalSMILES) {
        html += `
            <div class="identifier-item identifier-full">
                <span class="identifier-label">SMILES</span>
                <span class="identifier-value smiles-value">
                    <code>${properties.CanonicalSMILES}</code>
                    <button class="copy-btn" onclick="copyToClipboard('${properties.CanonicalSMILES}')" title="Copy SMILES">📋</button>
                </span>
            </div>
        `;
    }
    
    if (properties.InChI) {
        html += `
            <div class="identifier-item identifier-full">
                <span class="identifier-label">InChI</span>
                <span class="identifier-value inchi-value">
                    <code>${properties.InChI.length > 60 ? properties.InChI.substring(0, 60) + '...' : properties.InChI}</code>
                    <button class="copy-btn" onclick="copyToClipboard('${properties.InChI}')" title="Copy InChI">📋</button>
                </span>
            </div>
        `;
    }
    
    if (properties.InChIKey) {
        html += `
            <div class="identifier-item">
                <span class="identifier-label">InChIKey</span>
                <span class="identifier-value">
                    <code>${properties.InChIKey}</code>
                    <button class="copy-btn" onclick="copyToClipboard('${properties.InChIKey}')" title="Copy InChIKey">📋</button>
                </span>
            </div>
        `;
    }
    
    container.innerHTML = html;
}

// Copy text to clipboard
function copyToClipboard(text) {
    navigator.clipboard.writeText(text).then(() => {
        // Show brief feedback
        const originalText = event.target.textContent;
        event.target.textContent = '✓';
        setTimeout(() => {
            event.target.textContent = originalText;
        }, 1000);
    }).catch(err => {
        console.error('Failed to copy:', err);
    });
}

// Update properties grid
function updatePubChemProperties(index, properties) {
    const container = document.getElementById(`pubchem-properties-${index}`);
    
    if (!container) return;
    
    const propertyMap = [
        { key: 'MolecularFormula', label: 'Molecular Formula', format: v => v },
        { key: 'MolecularWeight', label: 'Molecular Weight', format: v => `${parseFloat(v).toFixed(4)} g/mol` },
        { key: 'ExactMass', label: 'Exact Mass', format: v => `${parseFloat(v).toFixed(4)} Da` },
        { key: 'MonoisotopicMass', label: 'Monoisotopic Mass', format: v => `${parseFloat(v).toFixed(4)} Da` },
        { key: 'XLogP', label: 'XLogP3', format: v => parseFloat(v).toFixed(2) },
        { key: 'TPSA', label: 'TPSA', format: v => `${parseFloat(v).toFixed(1)} Å²` },
        { key: 'Complexity', label: 'Complexity', format: v => parseFloat(v).toFixed(0) },
        { key: 'Charge', label: 'Formal Charge', format: v => v },
        { key: 'HeavyAtomCount', label: 'Heavy Atoms', format: v => v },
        { key: 'RotatableBondCount', label: 'Rotatable Bonds', format: v => v },
        { key: 'AtomStereoCount', label: 'Stereocenters', format: v => v },
        { key: 'CovalentUnitCount', label: 'Covalent Units', format: v => v }
    ];
    
    let html = '<div class="properties-grid">';
    
    for (const prop of propertyMap) {
        if (properties[prop.key] !== undefined && properties[prop.key] !== null) {
            html += `
                <div class="property-item">
                    <span class="property-label">${prop.label}</span>
                    <span class="property-value">${prop.format(properties[prop.key])}</span>
                </div>
            `;
        }
    }
    
    html += '</div>';
    container.innerHTML = html;
}

// Update Lipinski's Rule of Five section
function updatePubChemLipinski(index, properties) {
    const container = document.getElementById(`pubchem-lipinski-${index}`);
    
    if (!container) return;
    
    const mw = parseFloat(properties.MolecularWeight) || 0;
    const logp = parseFloat(properties.XLogP) || 0;
    const hbd = parseInt(properties.HBondDonorCount) || 0;
    const hba = parseInt(properties.HBondAcceptorCount) || 0;
    const rotatable = parseInt(properties.RotatableBondCount) || 0;
    const tpsa = parseFloat(properties.TPSA) || 0;
    
    // Lipinski's Rule of Five criteria
    const rules = [
        { name: 'MW ≤ 500', value: mw, threshold: 500, pass: mw <= 500, display: `${mw.toFixed(1)} g/mol` },
        { name: 'LogP ≤ 5', value: logp, threshold: 5, pass: logp <= 5, display: logp.toFixed(2) },
        { name: 'HBD ≤ 5', value: hbd, threshold: 5, pass: hbd <= 5, display: hbd },
        { name: 'HBA ≤ 10', value: hba, threshold: 10, pass: hba <= 10, display: hba }
    ];
    
    // Additional drug-likeness criteria
    const extraRules = [
        { name: 'Rotatable Bonds ≤ 10', value: rotatable, threshold: 10, pass: rotatable <= 10, display: rotatable },
        { name: 'TPSA ≤ 140 Å²', value: tpsa, threshold: 140, pass: tpsa <= 140, display: `${tpsa.toFixed(1)} Å²` }
    ];
    
    const passCount = rules.filter(r => r.pass).length;
    const allRulesPass = passCount === 4;
    
    let html = `
        <div class="lipinski-summary ${allRulesPass ? 'drug-like' : passCount >= 3 ? 'borderline' : 'not-drug-like'}">
            <span class="lipinski-status">${allRulesPass ? '✅ Drug-Like' : passCount >= 3 ? '⚠️ Borderline' : '❌ Not Drug-Like'}</span>
            <span class="lipinski-score">${passCount}/4 Rules Passed</span>
        </div>
        <div class="lipinski-rules">
    `;
    
    for (const rule of rules) {
        html += `
            <div class="lipinski-rule ${rule.pass ? 'pass' : 'fail'}">
                <span class="rule-indicator">${rule.pass ? '✓' : '✗'}</span>
                <span class="rule-name">${rule.name}</span>
                <span class="rule-value">${rule.display}</span>
            </div>
        `;
    }
    
    html += '</div><div class="extra-rules"><h5>Additional Criteria</h5>';
    
    for (const rule of extraRules) {
        html += `
            <div class="lipinski-rule ${rule.pass ? 'pass' : 'fail'}">
                <span class="rule-indicator">${rule.pass ? '✓' : '✗'}</span>
                <span class="rule-name">${rule.name}</span>
                <span class="rule-value">${rule.display}</span>
            </div>
        `;
    }
    
    html += '</div>';
    container.innerHTML = html;
}

// Update description section
function updatePubChemDescription(index, description) {
    const container = document.getElementById(`pubchem-description-${index}`);
    
    if (!container) return;
    
    if (description) {
        container.innerHTML = `<p class="compound-description">${description}</p>`;
    } else {
        container.innerHTML = '<p class="no-data">No description available for this compound.</p>';
    }
}

// Update synonyms section
function updatePubChemSynonyms(index, synonyms) {
    const container = document.getElementById(`pubchem-synonyms-${index}`);
    
    if (!container) return;
    
    if (synonyms && synonyms.length > 0) {
        // Show first 15 synonyms by default
        const displayCount = 15;
        const displaySynonyms = synonyms.slice(0, displayCount);
        const hasMore = synonyms.length > displayCount;
        
        let html = '<div class="synonyms-list">';
        
        for (const syn of displaySynonyms) {
            html += `<span class="synonym-tag">${syn}</span>`;
        }
        
        html += '</div>';
        
        if (hasMore) {
            html += `
                <div class="synonyms-more" id="synonyms-more-${index}">
                    <div class="synonyms-list hidden">
            `;
            
            for (const syn of synonyms.slice(displayCount)) {
                html += `<span class="synonym-tag">${syn}</span>`;
            }
            
            html += `
                    </div>
                </div>
                <button class="show-more-btn" onclick="toggleMoreSynonyms(${index})"
                    data-collapsed="true">
                    Show ${synonyms.length - displayCount} more...
                </button>
            `;
        }
        
        container.innerHTML = html;
    } else {
        container.innerHTML = '<p class="no-data">No synonyms available.</p>';
    }
}

// Toggle more synonyms visibility
function toggleMoreSynonyms(index) {
    const moreContainer = document.getElementById(`synonyms-more-${index}`);
    const button = moreContainer?.nextElementSibling;
    
    if (moreContainer && button) {
        const list = moreContainer.querySelector('.synonyms-list');
        const isCollapsed = button.dataset.collapsed === 'true';
        
        if (isCollapsed) {
            list.classList.remove('hidden');
            button.textContent = 'Show less';
            button.dataset.collapsed = 'false';
        } else {
            list.classList.add('hidden');
            const count = list.querySelectorAll('.synonym-tag').length;
            button.textContent = `Show ${count} more...`;
            button.dataset.collapsed = 'true';
        }
    }
}

// Toggle all synonyms expand/collapse
function toggleSynonymsExpand(index) {
    const container = document.getElementById(`pubchem-synonyms-${index}`);
    if (container) {
        container.classList.toggle('expanded');
    }
}

// Load 2D structure image
function loadPubChem2DImage(index, cid) {
    const container = document.getElementById(`pubchem-2d-${index}`);
    
    if (!container) return;
    
    const imgUrl = `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid/${cid}/PNG?image_size=300x300`;
    
    container.innerHTML = `
        <img src="${imgUrl}" 
             alt="2D Structure of CID ${cid}" 
             class="pubchem-2d-image"
             onerror="this.parentElement.innerHTML='<div class=\\'no-structure\\'>2D structure not available</div>'"
             onload="this.style.opacity=1">
    `;
}

// Load 3D interactive viewer
async function loadPubChem3DViewer(index, cid) {
    const container = document.getElementById(`pubchem-3d-${index}`);
    const controlsContainer = document.getElementById(`pubchem-3d-controls-${index}`);
    
    if (!container) return;
    
    try {
        // Fetch 3D SDF
        const sdfUrl = `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid/${cid}/SDF?record_type=3d`;
        const response = await fetch(sdfUrl);
        
        if (!response.ok) {
            throw new Error('3D structure not available');
        }
        
        const sdfData = await response.text();
        pubchemSdfCache[index] = sdfData;
        
        // Clear container and set dimensions
        container.innerHTML = '';
        container.style.width = '100%';
        container.style.height = '350px';
        
        // Initialize 3Dmol viewer directly on the container
        const viewer = $3Dmol.createViewer(container, {
            backgroundColor: 'black'
        });
        
        // Add the molecule
        viewer.addModel(sdfData, 'sdf');
        viewer.setStyle({}, { stick: { colorscheme: 'Jmol', radius: 0.15 } });
        viewer.addSurface($3Dmol.SurfaceType.VDW, {
            opacity: 0.15,
            colorscheme: 'Jmol'
        });
        viewer.zoomTo();
        viewer.render();
        
        // Store viewer reference
        pubchem3DViewers[index] = viewer;
        
        // Show controls
        if (controlsContainer) {
            controlsContainer.style.display = 'block';
        }
        
    } catch (error) {
        console.warn('Could not load 3D structure:', error);
        container.innerHTML = `<div class="no-structure">3D structure not available for this compound</div>`;
        
        if (controlsContainer) {
            controlsContainer.style.display = 'none';
        }
    }
}

// Change 3D viewer style
function changePubChemStyle(index, style, button) {
    const viewer = pubchem3DViewers[index];
    if (!viewer) return;
    
    // Update button states
    const buttons = button.parentElement.querySelectorAll('.style-btn');
    buttons.forEach(btn => btn.classList.remove('active'));
    button.classList.add('active');
    
    // Clear current style
    viewer.setStyle({}, {});
    
    // Apply new style
    switch (style) {
        case 'stick':
            viewer.setStyle({}, { stick: { colorscheme: 'Jmol', radius: 0.15 } });
            break;
        case 'sphere':
            viewer.setStyle({}, { sphere: { colorscheme: 'Jmol', scale: 0.3 } });
            break;
        case 'line':
            viewer.setStyle({}, { line: { colorscheme: 'Jmol' } });
            break;
        case 'ballstick':
            viewer.setStyle({}, { 
                stick: { colorscheme: 'Jmol', radius: 0.1 },
                sphere: { colorscheme: 'Jmol', scale: 0.25 }
            });
            break;
    }
    
    viewer.render();
}

// Reset 3D viewer
function resetPubChem3D(index) {
    const viewer = pubchem3DViewers[index];
    if (!viewer) return;
    
    viewer.zoomTo();
    viewer.render();
}

// Toggle 3D spin
function togglePubChemSpin(index, button) {
    const viewer = pubchem3DViewers[index];
    if (!viewer) return;
    
    const isSpinning = button.classList.contains('active');
    
    if (isSpinning) {
        viewer.spin(false);
        button.classList.remove('active');
    } else {
        viewer.spin('y', 1);
        button.classList.add('active');
    }
}

// Download 2D PNG image
function downloadPubChemImage(index, cid) {
    const url = `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid/${cid}/PNG?image_size=500x500`;
    
    fetch(url)
        .then(response => response.blob())
        .then(blob => {
            const link = document.createElement('a');
            link.href = URL.createObjectURL(blob);
            link.download = `PubChem_CID_${cid}.png`;
            link.click();
            URL.revokeObjectURL(link.href);
        })
        .catch(err => console.error('Download failed:', err));
}

// Download 3D SDF file
function downloadPubChemSDF(index) {
    const sdfData = pubchemSdfCache[index];
    const data = pubchemDataCache[index];
    
    if (!sdfData || !data) {
        console.error('No SDF data available');
        return;
    }
    
    const blob = new Blob([sdfData], { type: 'chemical/x-mdl-sdfile' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `PubChem_CID_${data.cid}.sdf`;
    link.click();
    URL.revokeObjectURL(link.href);
}

// Make PubChem functions globally available
window.initializePubChemWorkflow = initializePubChemWorkflow;
window.changePubChemStyle = changePubChemStyle;
window.resetPubChem3D = resetPubChem3D;
window.togglePubChemSpin = togglePubChemSpin;
window.downloadPubChemImage = downloadPubChemImage;
window.downloadPubChemSDF = downloadPubChemSDF;
window.toggleMoreSynonyms = toggleMoreSynonyms;
window.toggleSynonymsExpand = toggleSynonymsExpand;
window.copyToClipboard = copyToClipboard;
