/**
 * PDBViewer - A modular, self-contained 3D molecular viewer for PDB structures
 * 
 * This class encapsulates all PDB visualization logic and manages its own state.
 * It can be used independently anywhere by providing a container element and PDB code.
 * 
 * Usage:
 *   const viewer = new PDBViewer(document.getElementById('viewer-container'));
 *   await viewer.loadPDB('1CRN');
 *   
 *   // Toggle representations
 *   viewer.toggleRepresentation('cartoon');
 *   viewer.toggleRepresentation('surface');
 *   
 *   // Change colors
 *   viewer.setColorScheme('chain');
 *   
 *   // Export
 *   viewer.screenshot();
 */

class PDBViewer {
    constructor(containerElement, options = {}) {
        this.container = containerElement;
        this.options = {
            backgroundColor: options.backgroundColor || 'black',
            width: options.width || 650,
            height: options.height || 650,
            showControls: options.showControls !== false,
            onLoad: options.onLoad || null,
            onError: options.onError || null,
            ...options
        };
        
        // Internal state - completely self-contained
        this.viewer = null;
        this.pdbCode = null;
        this.pdbData = null;
        this.structureInfo = null;
        
        // Component visibility state
        this.components = {
            protein: true,
            ligand: true,
            water: false,
            ion: true,
            nucleic: true
        };
        
        // Representation styles state - each can be on/off independently
        this.styles = {
            cartoon: true,
            'ball+stick': false,
            spacefill: false,
            ribbon: false,
            surface: false
        };
        
        // Selection state
        this.selections = {
            backbone: true,
            sidechains: true,
            ligands: true,
            waters: false
        };
        
        // Secondary structure visibility
        this.secondaryStructure = {
            helix: true,
            sheet: true,
            loop: true
        };
        
        // Color scheme
        this.colorScheme = 'spectrum';
        
        // Spin animation
        this.isSpinning = false;
        this.spinInterval = null;
        
        // Labels state
        this.labelsVisible = false;
        
        // Surface state
        this.surfaceObj = null;
        
        // Binding pockets state
        this.pocketsHighlighted = false;
        
        // Initialize viewer element
        this._initContainer();
    }
    
    /**
     * Initialize the container with proper styling
     */
    _initContainer() {
        this.container.style.width = this.options.width + 'px';
        this.container.style.height = this.options.height + 'px';
        this.container.style.position = 'relative';
    }
    
    /**
     * Load a PDB structure by code
     * @param {string} pdbCode - The 4-character PDB code
     * @returns {Promise<boolean>} - Success status
     */
    async loadPDB(pdbCode) {
        this.pdbCode = pdbCode.toUpperCase();
        
        try {
            // Fetch PDB data
            this.pdbData = await this._fetchPDBData(this.pdbCode);
            
            if (!this.pdbData) {
                throw new Error('Failed to fetch PDB data');
            }
            
            // Create 3Dmol viewer
            const config = { backgroundColor: this.options.backgroundColor };
            this.viewer = $3Dmol.createViewer(this.container, config);
            
            // Load structure
            this.viewer.addModel(this.pdbData, "pdb");
            
            // Parse structure info
            this.structureInfo = this._parsePDBData(this.pdbData);
            
            // Apply initial styling
            this._applyStyles();
            
            // Render
            this.viewer.zoomTo();
            this.viewer.render();
            this.viewer.zoom(1.2, 1000);
            
            console.log(`PDBViewer: Loaded ${this.pdbCode}`);
            
            if (this.options.onLoad) {
                this.options.onLoad(this.structureInfo);
            }
            
            return true;
            
        } catch (error) {
            console.error('PDBViewer error:', error);
            this._showError(error.message);
            
            if (this.options.onError) {
                this.options.onError(error);
            }
            
            return false;
        }
    }
    
    /**
     * Load PDB data directly (instead of fetching by code)
     * @param {string} pdbData - Raw PDB file content
     * @param {string} name - Optional name for the structure
     */
    loadPDBData(pdbData, name = 'structure') {
        try {
            this.pdbCode = name;
            this.pdbData = pdbData;
            
            // Create 3Dmol viewer
            const config = { backgroundColor: this.options.backgroundColor };
            this.viewer = $3Dmol.createViewer(this.container, config);
            
            // Load structure
            this.viewer.addModel(this.pdbData, "pdb");
            
            // Parse structure info
            this.structureInfo = this._parsePDBData(this.pdbData);
            
            // Apply initial styling
            this._applyStyles();
            
            // Render
            this.viewer.zoomTo();
            this.viewer.render();
            this.viewer.zoom(1.2, 1000);
            
            if (this.options.onLoad) {
                this.options.onLoad(this.structureInfo);
            }
            
            return true;
            
        } catch (error) {
            console.error('PDBViewer error:', error);
            this._showError(error.message);
            return false;
        }
    }
    
    /**
     * Toggle a representation style on/off
     * @param {string} style - One of: 'cartoon', 'ball+stick', 'spacefill', 'ribbon', 'surface'
     * @returns {boolean} - New state of the style
     */
    toggleRepresentation(style) {
        if (!(style in this.styles)) {
            console.warn(`PDBViewer: Unknown style '${style}'`);
            return false;
        }
        
        this.styles[style] = !this.styles[style];
        this._applyStyles();
        return this.styles[style];
    }
    
    /**
     * Set a representation style explicitly
     * @param {string} style - Style name
     * @param {boolean} enabled - Whether to enable or disable
     */
    setRepresentation(style, enabled) {
        if (!(style in this.styles)) {
            console.warn(`PDBViewer: Unknown style '${style}'`);
            return;
        }
        
        this.styles[style] = enabled;
        this._applyStyles();
    }
    
    /**
     * Get all current representation states
     * @returns {Object} - Object with style names as keys and boolean states as values
     */
    getRepresentationStates() {
        return { ...this.styles };
    }
    
    /**
     * Set the color scheme
     * @param {string} scheme - One of: 'spectrum', 'chain', 'ss', 'residue', 'hydrophobicity', 'white'
     */
    setColorScheme(scheme) {
        this.colorScheme = scheme;
        this._applyStyles();
    }
    
    /**
     * Toggle component visibility
     * @param {string} component - One of: 'protein', 'ligand', 'water', 'ion', 'nucleic'
     * @param {boolean} visible - Optional explicit state
     * @returns {boolean} - New visibility state
     */
    toggleComponent(component, visible) {
        if (!(component in this.components)) {
            console.warn(`PDBViewer: Unknown component '${component}'`);
            return false;
        }
        
        this.components[component] = visible !== undefined ? visible : !this.components[component];
        this._applyStyles();
        return this.components[component];
    }
    
    /**
     * Toggle secondary structure visibility
     * @param {string} ssType - One of: 'helix', 'sheet', 'loop'
     * @returns {boolean} - New visibility state
     */
    toggleSecondaryStructure(ssType) {
        if (!(ssType in this.secondaryStructure)) {
            console.warn(`PDBViewer: Unknown secondary structure '${ssType}'`);
            return false;
        }
        
        this.secondaryStructure[ssType] = !this.secondaryStructure[ssType];
        this._applyStyles();
        return this.secondaryStructure[ssType];
    }
    
    /**
     * Toggle atom selection visibility
     * @param {string} selection - One of: 'backbone', 'sidechains', 'ligands', 'waters'
     * @returns {boolean} - New visibility state
     */
    toggleSelection(selection) {
        if (!(selection in this.selections)) {
            console.warn(`PDBViewer: Unknown selection '${selection}'`);
            return false;
        }
        
        this.selections[selection] = !this.selections[selection];
        this._applyStyles();
        return this.selections[selection];
    }
    
    /**
     * Reset the view to show the entire structure
     */
    resetView() {
        if (!this.viewer) return;
        this.viewer.zoomTo();
        this.viewer.render();
    }
    
    /**
     * Center the view on the structure
     */
    centerView() {
        if (!this.viewer) return;
        this.viewer.center();
        this.viewer.render();
    }
    
    /**
     * Toggle spin animation
     * @returns {boolean} - New spin state
     */
    toggleSpin() {
        this.isSpinning = !this.isSpinning;
        
        if (this.isSpinning) {
            this.spinInterval = setInterval(() => {
                if (this.viewer) {
                    this.viewer.rotate(1, {y: 1});
                    this.viewer.render();
                }
            }, 50);
        } else {
            if (this.spinInterval) {
                clearInterval(this.spinInterval);
                this.spinInterval = null;
            }
        }
        
        return this.isSpinning;
    }
    
    /**
     * Toggle residue labels
     * @returns {boolean} - New labels state
     */
    toggleLabels() {
        if (!this.viewer) return false;
        
        this.labelsVisible = !this.labelsVisible;
        
        if (this.labelsVisible) {
            // Add labels for CA atoms (one per residue)
            this.viewer.addLabel("", {
                alignment: 'center',
                backgroundColor: 'rgba(0,0,0,0.6)',
                fontColor: 'white',
                fontSize: 10
            }, {atom: 'CA'}, (atom) => {
                return atom.resn + atom.resi;
            });
        } else {
            this.viewer.removeAllLabels();
        }
        
        this.viewer.render();
        return this.labelsVisible;
    }
    
    /**
     * Highlight potential binding pockets
     * @returns {boolean} - New highlight state
     */
    highlightBindingPockets() {
        if (!this.viewer) return false;
        
        this.pocketsHighlighted = !this.pocketsHighlighted;
        
        if (this.pocketsHighlighted) {
            // Highlight ligand binding regions with spheres
            this.viewer.addStyle(
                {hetflag: true, not: {resn: ['HOH', 'WAT']}},
                {sphere: {radius: 2.0, color: 'yellow', opacity: 0.3}}
            );
        }
        
        this._applyStyles();
        return this.pocketsHighlighted;
    }
    
    /**
     * Add/remove molecular surface
     * @returns {boolean} - New surface state
     */
    toggleSurface() {
        return this.toggleRepresentation('surface');
    }
    
    /**
     * Take a screenshot and download it
     * @param {string} filename - Optional filename (without extension)
     */
    screenshot(filename) {
        if (!this.viewer) return;
        
        const imgData = this.viewer.pngURI();
        const link = document.createElement('a');
        link.href = imgData;
        link.download = filename || `${this.pdbCode}_screenshot.png`;
        link.click();
    }
    
    /**
     * Get the PDB data
     * @returns {string} - Raw PDB file content
     */
    getPDBData() {
        return this.pdbData;
    }
    
    /**
     * Download the PDB file
     * @param {string} filename - Optional filename
     */
    downloadPDB(filename) {
        if (!this.pdbData) return;
        
        const blob = new Blob([this.pdbData], { type: 'text/plain' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = filename || `${this.pdbCode}.pdb`;
        link.click();
        URL.revokeObjectURL(link.href);
    }
    
    /**
     * Get structure information
     * @returns {Object} - Parsed structure info
     */
    getStructureInfo() {
        return this.structureInfo;
    }
    
    /**
     * Destroy the viewer and clean up
     */
    destroy() {
        if (this.spinInterval) {
            clearInterval(this.spinInterval);
        }
        if (this.viewer) {
            this.viewer.clear();
        }
        this.container.innerHTML = '';
    }
    
    // ==================== PRIVATE METHODS ====================
    
    /**
     * Fetch PDB data from RCSB
     */
    async _fetchPDBData(pdbCode) {
        const url = `https://files.rcsb.org/download/${pdbCode}.pdb`;
        const response = await fetch(url);
        
        if (!response.ok) {
            throw new Error(`Failed to fetch PDB ${pdbCode}: ${response.status}`);
        }
        
        return await response.text();
    }
    
    /**
     * Apply all current styles to the viewer
     */
    _applyStyles() {
        if (!this.viewer) return;
        
        // Clear all styles
        this.viewer.setStyle({}, {});
        this.viewer.removeAllSurfaces();
        
        const proteinSelector = {not: {hetflag: true}};
        
        // Get color configuration
        const colorConfig = this._getColorConfig();
        
        // Apply protein styles if protein is visible
        if (this.components.protein) {
            // Cartoon representation
            if (this.styles.cartoon) {
                this.viewer.addStyle(proteinSelector, {
                    cartoon: { ...colorConfig }
                });
            }
            
            // Ball and stick representation
            if (this.styles['ball+stick']) {
                this.viewer.addStyle(proteinSelector, {
                    stick: {radius: 0.2, colorscheme: 'default'},
                    sphere: {radius: 0.4, colorscheme: 'default'}
                });
            }
            
            // Spacefill representation
            if (this.styles.spacefill) {
                this.viewer.addStyle(proteinSelector, {
                    sphere: {colorscheme: 'default'}
                });
            }
            
            // Ribbon representation
            if (this.styles.ribbon) {
                this.viewer.addStyle(proteinSelector, {
                    cartoon: {style: 'trace', ...colorConfig, thickness: 0.5}
                });
            }
            
            // Surface representation
            if (this.styles.surface) {
                this.viewer.addSurface($3Dmol.SurfaceType.VDW, {
                    opacity: 0.65,
                    colorscheme: {prop: 'ss', scheme: 'RdYlBu'}
                }, proteinSelector);
            }
        }
        
        // Apply ligand styles
        if (this.components.ligand) {
            this.viewer.addStyle(
                {hetflag: true, not: {resn: ['HOH', 'WAT'], atom: ['NA', 'CL', 'MG', 'CA', 'ZN', 'FE', 'MN', 'CU', 'K']}},
                {stick: {radius: 0.3, colorscheme: 'default'}}
            );
        }
        
        // Apply ion styles
        if (this.components.ion) {
            this.viewer.addStyle(
                {atom: ['NA', 'CL', 'MG', 'CA', 'ZN', 'FE', 'MN', 'CU', 'K']},
                {sphere: {radius: 1.0, colorscheme: 'Jmol'}}
            );
        }
        
        // Apply water styles
        if (this.components.water) {
            this.viewer.addStyle(
                {resn: ['HOH', 'WAT']},
                {sphere: {radius: 0.3, color: 'cyan', opacity: 0.6}}
            );
        }
        
        this.viewer.render();
    }
    
    /**
     * Get color configuration based on current scheme
     */
    _getColorConfig() {
        switch (this.colorScheme) {
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
    
    /**
     * Parse PDB data to extract structure information
     */
    _parsePDBData(pdbData) {
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
        const bFactors = [];
        
        let atomCount = 0;
        let modelCount = 1;
        let title = '';
        let header = '';
        let resolution = null;
        let experimentMethod = '';
        
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
            // Parse header info
            if (line.startsWith('HEADER')) {
                header = line.substring(10, 50).trim();
            }
            if (line.startsWith('TITLE')) {
                title += line.substring(10).trim() + ' ';
            }
            if (line.startsWith('EXPDTA')) {
                experimentMethod = line.substring(10).trim();
            }
            if (line.startsWith('REMARK   2 RESOLUTION')) {
                const match = line.match(/(\d+\.?\d*)\s*ANGSTROMS/);
                if (match) resolution = parseFloat(match[1]);
            }
            
            if (line.startsWith('MODEL')) {
                const match = line.match(/MODEL\s+(\d+)/);
                if (match) modelCount = Math.max(modelCount, parseInt(match[1]));
            }
            
            if (line.startsWith('ATOM  ') || line.startsWith('HETATM')) {
                atomCount++;
                
                const atomName = line.substring(12, 16).trim();
                const resName = line.substring(17, 20).trim();
                const chain = line.substring(21, 22).trim() || 'A';
                const resNo = parseInt(line.substring(22, 26).trim());
                const element = line.substring(76, 78).trim() || atomName.substring(0, 1);
                const bFactor = parseFloat(line.substring(60, 66).trim());
                const isHetero = line.startsWith('HETATM');
                
                if (!isNaN(bFactor)) {
                    bFactors.push(bFactor);
                }
                
                elements.set(element, (elements.get(element) || 0) + 1);
                atomTypes.set(atomName, (atomTypes.get(atomName) || 0) + 1);
                
                const resKey = `${chain}:${resName}${resNo}`;
                residues.add(resKey);
                
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
        
        // Calculate average B-factor
        const avgBFactor = bFactors.length > 0 
            ? bFactors.reduce((a, b) => a + b, 0) / bFactors.length 
            : null;
        
        return {
            pdbCode: this.pdbCode,
            title: title.trim(),
            header,
            experimentMethod,
            resolution,
            atomCount,
            residueCount: residues.size,
            chainCount: chains.size,
            chains: Object.fromEntries(chains),
            ligands: Object.fromEntries(ligands),
            waterCount: waters.size,
            ions: Object.fromEntries(ions),
            proteins: Object.fromEntries(proteins),
            nucleics: Object.fromEntries(nucleics),
            elements: Object.fromEntries(elements),
            avgBFactor,
            modelCount
        };
    }
    
    /**
     * Show error message in container
     */
    _showError(message) {
        this.container.innerHTML = `
            <div class="pdb-viewer-error" style="
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: center;
                height: 100%;
                color: #ff6b6b;
                text-align: center;
                padding: 2rem;
                background: rgba(0,0,0,0.8);
                border-radius: 8px;
            ">
                <p style="font-size: 1.2rem;">⚠️ Error loading 3D structure</p>
                <p style="margin-top: 0.5rem;">PDB Code: ${this.pdbCode}</p>
                <p style="font-size: 0.9rem; margin-top: 1rem; color: #aaa;">${message}</p>
                <a href="https://www.rcsb.org/structure/${this.pdbCode}" target="_blank" 
                   style="margin-top: 1rem; color: #06b6d4; text-decoration: none;">
                   View on RCSB PDB →
                </a>
            </div>
        `;
    }
}

// Export for module systems
if (typeof module !== 'undefined' && module.exports) {
    module.exports = PDBViewer;
}

// Make available globally
window.PDBViewer = PDBViewer;
