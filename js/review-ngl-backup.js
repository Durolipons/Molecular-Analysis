// Load selected molecules from localStorage
let selectedMolecules = [];

// Initialize the review page
document.addEventListener('DOMContentLoaded', () => {
    loadSelectedItems();
    displaySummary();
    displayReferencePanels();
});

// Load selected items from localStorage
function loadSelectedItems() {
    const stored = localStorage.getItem('selectedMolecules');
    if (stored) {
        try {
            selectedMolecules = JSON.parse(stored);
        } catch (error) {
            console.error('Error parsing selected molecules:', error);
            selectedMolecules = [];
        }
    }
}

// Display summary statistics
function displaySummary() {
    if (selectedMolecules.length === 0) {
        document.getElementById('summary-section').classList.add('hidden');
        document.getElementById('panels-container').classList.add('hidden');
        document.getElementById('no-selection').classList.remove('hidden');
        return;
    }

    // Count by type
    let pdbCount = 0;
    let proteinCount = 0;
    let compoundCount = 0;

    selectedMolecules.forEach(item => {
        const dbType = item.database.toLowerCase();
        if (dbType.includes('pdb')) {
            pdbCount++;
        } else if (dbType.includes('uniprot') || dbType.includes('alphafold')) {
            proteinCount++;
        } else if (dbType.includes('pubchem') || dbType.includes('chembl')) {
            compoundCount++;
        }
    });

    document.getElementById('total-items').textContent = selectedMolecules.length;
    document.getElementById('pdb-count').textContent = pdbCount;
    document.getElementById('protein-count').textContent = proteinCount;
    document.getElementById('compound-count').textContent = compoundCount;
}

// Display reference panels for each selected item
function displayReferencePanels() {
    const container = document.getElementById('panels-container');
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

    // Extract PDB code if it's a PDB item
    const isPDB = item.database.toLowerCase().includes('pdb');
    const pdbCode = isPDB ? extractPDBCode(item) : null;

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
                <div class="viewer-layout">
                    <div class="viewer-left-panel">
                        <div class="viewer-header">
                            <h4>3D Structure Viewer</h4>
                            <span class="pdb-code-badge">PDB: ${pdbCode}</span>
                        </div>
                        
                        <div class="selection-panel">
                            <h5>Display Components</h5>
                            <label class="checkbox-option">
                                <input type="checkbox" id="show-protein-${index}" checked onchange="toggleComponent(${index}, 'protein', this.checked)">
                                <span>Protein</span>
                            </label>
                            <label class="checkbox-option">
                                <input type="checkbox" id="show-ligand-${index}" checked onchange="toggleComponent(${index}, 'ligand', this.checked)">
                                <span>Ligands</span>
                            </label>
                            <label class="checkbox-option">
                                <input type="checkbox" id="show-water-${index}" onchange="toggleComponent(${index}, 'water', this.checked)">
                                <span>Water</span>
                            </label>
                            <label class="checkbox-option">
                                <input type="checkbox" id="show-ion-${index}" checked onchange="toggleComponent(${index}, 'ion', this.checked)">
                                <span>Ions</span>
                            </label>
                            <label class="checkbox-option">
                                <input type="checkbox" id="show-nucleic-${index}" checked onchange="toggleComponent(${index}, 'nucleic', this.checked)">
                                <span>Nucleic Acids</span>
                            </label>
                        </div>
                        
                        <div id="viewer-${index}" class="ngl-viewer"></div>
                        
                        <div class="style-controls">
                            <h5>Representation Style</h5>
                            <div class="style-buttons">
                                <button class="style-btn active" onclick="changeRepresentation(${index}, 'cartoon')" data-style="cartoon">
                                    Cartoon
                                </button>
                                <button class="style-btn" onclick="changeRepresentation(${index}, 'ball+stick')" data-style="ball+stick">
                                    Ball & Stick
                                </button>
                                <button class="style-btn" onclick="changeRepresentation(${index}, 'spacefill')" data-style="spacefill">
                                    Space Fill
                                </button>
                                <button class="style-btn" onclick="changeRepresentation(${index}, 'ribbon')" data-style="ribbon">
                                    Ribbon
                                </button>
                                <button class="style-btn" onclick="changeRepresentation(${index}, 'surface')" data-style="surface">
                                    Surface
                                </button>
                            </div>
                            <div class="viewer-actions">
                                <button class="control-btn" onclick="resetView(${index})">Reset View</button>
                                <button class="control-btn" onclick="toggleSpin(${index})">Toggle Spin</button>
                                <button class="control-btn" onclick="centerView(${index})">Center</button>
                            </div>
                        </div>
                    </div>
                    
                    <div class="viewer-right-panel" id="details-${index}">
                        <h4>Structure Details</h4>
                        <div class="loading-details">Loading structure information...</div>
                    </div>
                </div>
            ` : ''}

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

    // Initialize 3D viewer for PDB structures
    if (isPDB && pdbCode) {
        setTimeout(() => initializeMolstarViewer(index, pdbCode), 100);
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

// Initialize NGL viewer for PDB structure
let viewers = {};
let stages = {};
let components = {};
let pdbDataCache = {};
let spinIntervals = {};

async function initializeMolstarViewer(index, pdbCode) {
    const viewerId = `viewer-${index}`;
    const element = document.getElementById(viewerId);
    
    if (!element) {
        console.error('Viewer element not found:', viewerId);
        return;
    }

    try {
        // Create NGL Stage with black background
        const stage = new NGL.Stage(element, {
            backgroundColor: 'black',
            quality: 'high',
            sampleLevel: 2,
            ambientIntensity: 0.5,
            lightIntensity: 1.0
        });
        
        stages[index] = stage;
        components[index] = {};

        // Handle window resize
        window.addEventListener('resize', () => stage.handleResize());

        // Fetch PDB file data
        const pdbData = await fetchPDBData(pdbCode);
        
        if (!pdbData) {
            throw new Error('Failed to fetch PDB data');
        }

        // Create a blob from the PDB data
        const blob = new Blob([pdbData], { type: 'text/plain' });
        
        // Load structure from blob
        const structureComponent = await stage.loadFile(blob, { ext: 'pdb' });
        viewers[index] = structureComponent;

        // Add default representations with better colors
        components[index].protein = structureComponent.addRepresentation('cartoon', {
            sele: 'protein',
            color: 'chainname',
            quality: 'high'
        });

        components[index].ligand = structureComponent.addRepresentation('ball+stick', {
            sele: 'hetero and not water',
            color: 'element',
            colorScheme: 'element',
            quality: 'high',
            radiusScale: 0.3
        });

        components[index].ion = structureComponent.addRepresentation('spacefill', {
            sele: 'ion',
            color: 'element',
            radiusScale: 1.5
        });

        components[index].nucleic = structureComponent.addRepresentation('cartoon', {
            sele: 'nucleic',
            color: 'resname',
            quality: 'high'
        });

        // Center and zoom
        stage.autoView();
        
        console.log(`Loaded PDB structure: ${pdbCode}`);
        
        // Load structure details
        await loadStructureDetails(index, pdbCode, structureComponent.structure);
        
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
        const response = await fetch(`https://files.rcsb.org/download/${pdbCode}.pdb`, {
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
        
        // Dispose viewer if exists
        if (viewers[index]) {
            viewers[index].dispose();
            delete viewers[index];
        }
        
        displaySummary();
        displayReferencePanels();
    }
}

// Toggle component visibility
function toggleComponent(index, componentType, visible) {
    if (components[index] && components[index][componentType]) {
        components[index][componentType].setVisibility(visible);
    }
}

// Change representation style
function changeRepresentation(index, style) {
    const stage = stages[index];
    const viewer = viewers[index];
    
    if (!stage || !viewer) return;

    // Remove all representations
    viewer.removeAllRepresentations();
    components[index] = {};

    // Update button states
    const panel = document.getElementById(`panel-${index}`);
    if (panel) {
        panel.querySelectorAll('.style-btn').forEach(btn => {
            btn.classList.remove('active');
            if (btn.getAttribute('onclick').includes(`'${style}'`)) {
                btn.classList.add('active');
            }
        });
    }

    // Add new representation based on style
    switch (style) {
        case 'cartoon':
            components[index].protein = viewer.addRepresentation('cartoon', {
                sele: 'protein',
                color: 'chainname'
            });
            components[index].ligand = viewer.addRepresentation('ball+stick', {
                sele: 'hetero and not water',
                color: 'element'
            });
            break;
        case 'ball+stick':
            components[index].protein = viewer.addRepresentation('ball+stick', {
                sele: 'protein',
                color: 'chainname'
            });
            components[index].ligand = viewer.addRepresentation('ball+stick', {
                sele: 'hetero and not water',
                color: 'element'
            });
            break;
        case 'spacefill':
            components[index].protein = viewer.addRepresentation('spacefill', {
                sele: 'protein',
                color: 'chainname'
            });
            components[index].ligand = viewer.addRepresentation('spacefill', {
                sele: 'hetero and not water',
                color: 'element'
            });
            break;
        case 'ribbon':
            components[index].protein = viewer.addRepresentation('ribbon', {
                sele: 'protein',
                color: 'chainname'
            });
            components[index].ligand = viewer.addRepresentation('ball+stick', {
                sele: 'hetero and not water',
                color: 'element'
            });
            break;
        case 'surface':
            components[index].protein = viewer.addRepresentation('surface', {
                sele: 'protein',
                color: 'chainname',
                surfaceType: 'sas'
            });
            components[index].ligand = viewer.addRepresentation('ball+stick', {
                sele: 'hetero and not water',
                color: 'element'
            });
            break;
    }

    // Add ions and nucleic acids if checked
    const ionCheckbox = document.getElementById(`show-ion-${index}`);
    if (ionCheckbox && ionCheckbox.checked) {
        components[index].ion = viewer.addRepresentation('spacefill', {
            sele: 'ion',
            color: 'element'
        });
    }

    const nucleicCheckbox = document.getElementById(`show-nucleic-${index}`);
    if (nucleicCheckbox && nucleicCheckbox.checked) {
        components[index].nucleic = viewer.addRepresentation('cartoon', {
            sele: 'nucleic',
            color: 'nucleicbase'
        });
    }
}

// Reset view in 3D viewer
function resetView(index) {
    if (stages[index]) {
        stages[index].autoView(1000);
    }
}

// Center view
function centerView(index) {
    if (stages[index]) {
        stages[index].centerView();
    }
}

// Toggle spin animation
function toggleSpin(index) {
    const stage = stages[index];
    if (!stage) return;

    if (spinIntervals[index]) {
        clearInterval(spinIntervals[index]);
        spinIntervals[index] = null;
    } else {
        spinIntervals[index] = setInterval(() => {
            stage.spinAnimation.axis.set(0, 1, 0);
            stage.setSpin([0, 0.01, 0]);
        }, 10);
    }
}

// Load structure details
async function loadStructureDetails(index, pdbCode, structure) {
    const detailsElement = document.getElementById(`details-${index}`);
    if (!detailsElement) return;

    try {
        // Get structure information from NGL
        const atomCount = structure.atomCount;
        const residueCount = structure.residueStore.count;
        const chainCount = structure.chainStore.count;
        const modelCount = structure.modelStore.count;

        // Detailed component tracking
        const chains = new Map();
        const ligands = new Map();
        const waters = new Set();
        const ions = new Map();
        const proteins = new Map();
        const nucleics = new Map();
        const atomTypes = new Map();
        const elements = new Map();
        
        structure.eachChain((chain) => {
            const chainInfo = {
                name: chain.chainname,
                residueCount: chain.residueCount,
                atomCount: chain.atomCount,
                residues: [],
                ligands: [],
                waters: 0,
                ions: []
            };
            
            chain.eachResidue((residue) => {
                const resName = residue.resname;
                const resNo = residue.resno;
                const fullId = `${chain.chainname}:${resName}${resNo}`;
                
                if (residue.isWater()) {
                    chainInfo.waters++;
                    waters.add(resName);
                } else if (residue.isIon()) {
                    chainInfo.ions.push({ resName, resNo, atomCount: residue.atomCount });
                    const ionKey = resName;
                    ions.set(ionKey, (ions.get(ionKey) || 0) + 1);
                } else if (residue.isProtein()) {
                    chainInfo.residues.push({ resName, resNo, atomCount: residue.atomCount });
                    const proteinKey = resName;
                    proteins.set(proteinKey, (proteins.get(proteinKey) || 0) + 1);
                } else if (residue.isNucleic()) {
                    chainInfo.residues.push({ resName, resNo, atomCount: residue.atomCount });
                    const nucleicKey = resName;
                    nucleics.set(nucleicKey, (nucleics.get(nucleicKey) || 0) + 1);
                } else {
                    // Ligand or other hetero
                    chainInfo.ligands.push({ resName, resNo, atomCount: residue.atomCount });
                    const ligandKey = resName;
                    ligands.set(ligandKey, (ligands.get(ligandKey) || 0) + 1);
                }
            });
            
            chains.set(chain.chainname, chainInfo);
        });

        // Count atom types and elements
        structure.eachAtom((atom) => {
            const atomName = atom.atomname;
            const element = atom.element;
            atomTypes.set(atomName, (atomTypes.get(atomName) || 0) + 1);
            elements.set(element, (elements.get(element) || 0) + 1);
        });

        // Try to fetch additional metadata
        let metadata = null;
        try {
            const response = await fetch(`https://data.rcsb.org/rest/v1/core/entry/${pdbCode}`);
            if (response.ok) {
                metadata = await response.json();
            }
        } catch (e) {
            console.log('Could not fetch metadata:', e);
        }

        let html = '<h4>Structure Details</h4><div class="details-content">';
        
        html += `<div class="detail-item"><strong>PDB Code:</strong> ${pdbCode.toUpperCase()}</div>`;
        
        if (metadata) {
            html += metadata.struct?.title ? `<div class="detail-item"><strong>Title:</strong> ${metadata.struct.title}</div>` : '';
            html += metadata.exptl?.[0]?.method ? `<div class="detail-item"><strong>Method:</strong> ${metadata.exptl[0].method}</div>` : '';
            html += metadata.rcsb_entry_info?.resolution_combined?.[0] ? 
                `<div class="detail-item"><strong>Resolution:</strong> ${metadata.rcsb_entry_info.resolution_combined[0]} Å</div>` : '';
            html += metadata.rcsb_accession_info?.initial_release_date ? 
                `<div class="detail-item"><strong>Release Date:</strong> ${metadata.rcsb_accession_info.initial_release_date.split('T')[0]}</div>` : '';
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

        // Elements breakdown
        if (elements.size > 0) {
            html += `<div class="detail-section"><h5>Elements (Toggle by Element)</h5>`;
            const sortedElements = Array.from(elements.entries()).sort((a, b) => b[1] - a[1]);
            sortedElements.forEach(([element, count]) => {
                const fullName = formatName(element, 'element');
                html += `
                    <label class="detail-checkbox element-checkbox">
                        <input type="checkbox" checked onchange="toggleElement(${index}, '${element}', this.checked)">
                        <span><strong>${fullName}:</strong> ${count.toLocaleString()} atoms</span>
                    </label>
                `;
            });
            html += `</div>`;
        }

        // Protein residues breakdown
        if (proteins.size > 0) {
            html += `<div class="detail-section"><h5>Protein Residues (by type)</h5>`;
            const sortedProteins = Array.from(proteins.entries()).sort((a, b) => b[1] - a[1]);
            sortedProteins.forEach(([resName, count]) => {
                const fullName = formatName(resName, 'amino');
                html += `
                    <label class="detail-checkbox protein-checkbox">
                        <input type="checkbox" checked onchange="toggleResidue(${index}, '${resName}', this.checked)">
                        <span><strong>${fullName}:</strong> ${count} residues</span>
                    </label>
                `;
            });
            html += `</div>`;
        }

        // Nucleic acids breakdown
        if (nucleics.size > 0) {
            html += `<div class="detail-section"><h5>Nucleic Acids</h5>`;
            const sortedNucleics = Array.from(nucleics.entries()).sort((a, b) => b[1] - a[1]);
            sortedNucleics.forEach(([resName, count]) => {
                const fullName = formatName(resName, 'nucleic');
                html += `
                    <label class="detail-checkbox nucleic-checkbox">
                        <input type="checkbox" checked onchange="toggleResidue(${index}, '${resName}', this.checked)">
                        <span><strong>${fullName}:</strong> ${count} residues</span>
                    </label>
                `;
            });
            html += `</div>`;
        }

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

        // Ions breakdown
        if (ions.size > 0) {
            html += `<div class="detail-section"><h5>Ions (by type)</h5>`;
            const sortedIons = Array.from(ions.entries()).sort((a, b) => b[1] - a[1]);
            sortedIons.forEach(([resName, count]) => {
                const fullName = formatName(resName, 'ion');
                html += `
                    <label class="detail-checkbox ion-checkbox">
                        <input type="checkbox" checked onchange="toggleIon(${index}, '${resName}', this.checked)">
                        <span><strong>${fullName}:</strong> ${count} ion(s)</span>
                    </label>
                `;
            });
            html += `</div>`;
        }

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

        // Atom types (top 20)
        if (atomTypes.size > 0) {
            html += `<div class="detail-section"><h5>Atom Types (top 20)</h5>`;
            const sortedAtoms = Array.from(atomTypes.entries()).sort((a, b) => b[1] - a[1]).slice(0, 20);
            sortedAtoms.forEach(([atomName, count]) => {
                const fullName = formatName(atomName, 'atom');
                html += `
                    <label class="detail-checkbox atom-checkbox">
                        <input type="checkbox" checked onchange="toggleAtomType(${index}, '${atomName}', this.checked)">
                        <span><strong>${fullName}:</strong> ${count.toLocaleString()}</span>
                    </label>
                `;
            });
            html += `</div>`;
        }

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
    const stage = stages[index];
    
    if (!viewer || !stage) return;

    switch (componentType) {
        case 'all-atoms':
        case 'all-residues':
        case 'all-chains':
            // Toggle all protein/structure visibility
            if (components[index].protein) {
                components[index].protein.setVisibility(visible);
            }
            if (components[index].nucleic) {
                components[index].nucleic.setVisibility(visible);
            }
            break;
            
        case 'models':
            // Toggle model visibility (usually just one model)
            viewer.setVisibility(visible);
            break;
            
        case 'ligands':
            if (components[index].ligand) {
                components[index].ligand.setVisibility(visible);
            }
            // Update checkbox in left panel
            const ligandCheckbox = document.getElementById(`show-ligand-${index}`);
            if (ligandCheckbox) ligandCheckbox.checked = visible;
            break;
            
        case 'waters':
            // Add or remove water representation
            if (visible) {
                if (!components[index].water) {
                    components[index].water = viewer.addRepresentation('ball+stick', {
                        sele: 'water',
                        color: 'element',
                        scale: 0.5
                    });
                }
            } else {
                if (components[index].water) {
                    components[index].water.dispose();
                    delete components[index].water;
                }
            }
            // Update checkbox in left panel
            const waterCheckbox = document.getElementById(`show-water-${index}`);
            if (waterCheckbox) waterCheckbox.checked = visible;
            break;
            
        case 'ions':
            if (components[index].ion) {
                components[index].ion.setVisibility(visible);
            }
            // Update checkbox in left panel
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

    if (visible) {
        if (!chainComponents[index][chainName]) {
            chainComponents[index][chainName] = viewer.addRepresentation('cartoon', {
                sele: `:${chainName}`,
                color: 'chainname'
            });
        } else {
            chainComponents[index][chainName].setVisibility(true);
        }
    } else {
        if (chainComponents[index][chainName]) {
            chainComponents[index][chainName].setVisibility(false);
        }
    }
}

// Toggle specific residue type
function toggleResidue(index, resName, visible) {
    const viewer = viewers[index];
    if (!viewer) return;

    if (!residueComponents[index]) residueComponents[index] = {};

    if (visible) {
        if (!residueComponents[index][resName]) {
            residueComponents[index][resName] = viewer.addRepresentation('cartoon', {
                sele: `[${resName}]`,
                color: 'residueindex'
            });
        } else {
            residueComponents[index][resName].setVisibility(true);
        }
    } else {
        if (residueComponents[index][resName]) {
            residueComponents[index][resName].setVisibility(false);
        }
    }
}

// Toggle specific ligand
function toggleLigand(index, resName, visible) {
    const viewer = viewers[index];
    if (!viewer) return;

    if (!ligandComponents[index]) ligandComponents[index] = {};

    if (visible) {
        if (!ligandComponents[index][resName]) {
            ligandComponents[index][resName] = viewer.addRepresentation('ball+stick', {
                sele: `[${resName}] and hetero`,
                color: 'element'
            });
        } else {
            ligandComponents[index][resName].setVisibility(true);
        }
    } else {
        if (ligandComponents[index][resName]) {
            ligandComponents[index][resName].setVisibility(false);
        }
    }
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

    if (visible) {
        if (!ionComponents[index][resName]) {
            ionComponents[index][resName] = viewer.addRepresentation('spacefill', {
                sele: `[${resName}] and ion`,
                color: 'element'
            });
        } else {
            ionComponents[index][resName].setVisibility(true);
        }
    } else {
        if (ionComponents[index][resName]) {
            ionComponents[index][resName].setVisibility(false);
        }
    }
}

// Toggle by element
function toggleElement(index, element, visible) {
    const viewer = viewers[index];
    if (!viewer) return;

    if (!elementComponents[index]) elementComponents[index] = {};

    if (visible) {
        if (!elementComponents[index][element]) {
            elementComponents[index][element] = viewer.addRepresentation('ball+stick', {
                sele: `_${element}`,
                color: 'element'
            });
        } else {
            elementComponents[index][element].setVisibility(true);
        }
    } else {
        if (elementComponents[index][element]) {
            elementComponents[index][element].setVisibility(false);
        }
    }
}

// Toggle by atom type
function toggleAtomType(index, atomName, visible) {
    const viewer = viewers[index];
    if (!viewer) return;

    if (!atomTypeComponents[index]) atomTypeComponents[index] = {};

    if (visible) {
        if (!atomTypeComponents[index][atomName]) {
            atomTypeComponents[index][atomName] = viewer.addRepresentation('ball+stick', {
                sele: `.${atomName}`,
                color: 'element',
                scale: 0.5
            });
        } else {
            atomTypeComponents[index][atomName].setVisibility(true);
        }
    } else {
        if (atomTypeComponents[index][atomName]) {
            atomTypeComponents[index][atomName].setVisibility(false);
        }
    }
}

// Show PDB details
async function showPDBInfo(pdbCode) {
    try {
        // Fetch PDB metadata from RCSB API
        const response = await fetch(`https://data.rcsb.org/rest/v1/core/entry/${pdbCode}`);
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
