// Database configurations with API endpoints and search examples
const databases = {
    alphafold: {
        name: 'AlphaFold',
        description: 'AlphaFold Protein Structure Database - AI-predicted protein structures from DeepMind.',
        examples: ['P12345', 'O15552', 'Q9Y6K9', 'Hemoglobin'],
        placeholder: 'Enter UniProt ID (e.g., P12345)',
        searchUrl: (query) => `https://rest.uniprot.org/uniprotkb/search?query=${encodeURIComponent(query)}&format=json&size=5`,
        resultUrl: (id) => `https://alphafold.ebi.ac.uk/entry/${id}`
    },
    pdb: {
        name: 'Protein Data Bank (PDB)',
        description: 'The worldwide repository for experimentally determined 3D structures of proteins, nucleic acids, and complex assemblies.',
        examples: ['1CRN', '4HHB', '1AKE', '2GBP'],
        placeholder: 'Enter PDB ID (e.g., 1CRN)',
        searchUrl: (query) => {
            const searchQuery = {
                "query": {
                    "type": "terminal",
                    "service": "full_text",
                    "parameters": {
                        "value": query
                    }
                },
                "return_type": "entry",
                "request_options": {
                    "paginate": {
                        "start": 0,
                        "rows": 10
                    },
                    "results_content_type": ["experimental"],
                    "sort": [
                        {
                            "sort_by": "score",
                            "direction": "desc"
                        }
                    ]
                }
            };
            return `https://search.rcsb.org/rcsbsearch/v2/query`;
        },
        searchBody: (query) => {
            return {
                "query": {
                    "type": "terminal",
                    "service": "full_text",
                    "parameters": {
                        "value": query
                    }
                },
                "return_type": "entry",
                "request_options": {
                    "paginate": {
                        "start": 0,
                        "rows": 10
                    },
                    "results_content_type": ["experimental"],
                    "sort": [
                        {
                            "sort_by": "score",
                            "direction": "desc"
                        }
                    ]
                }
            };
        },
        resultUrl: (id) => `https://www.rcsb.org/structure/${id}`
    },
    kegg: {
        name: 'KEGG Database',
        description: 'Kyoto Encyclopedia of Genes and Genomes - Pathway, disease, drug, and genome databases.',
        examples: ['hsa00010', 'C00002', 'D00001', 'serotonin', 'insulin'],
        placeholder: 'Enter KEGG ID or search term (e.g., hsa00010, C00002, or serotonin)',
        searchUrl: (query) => {
            // Check if it's a KEGG ID pattern
            const isKeggId = query.match(/^([a-z]{2,4}[:\d]|[CDGRKM]\d{5}|map\d{5}|\d+\.\d+\.\d+)/i);
            // Use CORS proxy since KEGG API doesn't support CORS
            const corsProxy = 'https://corsproxy.io/?';
            if (isKeggId) {
                return corsProxy + encodeURIComponent(`https://rest.kegg.jp/get/${query}`);
            } else {
                // Text search - search compound database (most common use case)
                return corsProxy + encodeURIComponent(`https://rest.kegg.jp/find/compound/${query}`);
            }
        },
        resultUrl: (id) => `https://www.genome.jp/entry/${id}`
    },
    pubchem: {
        name: 'PubChem Compounds',
        description: 'Open chemistry database with information on chemical compounds and their biological activities.',
        examples: ['2244', '5793', '702', 'aspirin'],
        placeholder: 'Enter CID or compound name (e.g., 2244 or aspirin)',
        searchUrl: (query) => {
            const isNumeric = /^\d+$/.test(query);
            if (isNumeric) {
                return `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid/${query}/property/Title,MolecularFormula,MolecularWeight,CanonicalSMILES,InChIKey/JSON`;
            } else {
                // Use name_type=word to get multiple compound matches
                return `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/${encodeURIComponent(query)}/cids/JSON?name_type=word`;
            }
        },
        resultUrl: (id) => `https://pubchem.ncbi.nlm.nih.gov/compound/${id}`
    },
    pubchem_substances: {
        name: 'PubChem Substances',
        description: 'Chemical substance records submitted by data depositors to PubChem.',
        hidden: true, // Don't show in database list, it's part of PubChem
        searchUrl: (query) => {
            const isNumeric = /^\d+$/.test(query);
            if (isNumeric) {
                return `https://pubchem.ncbi.nlm.nih.gov/rest/pug/substance/sid/${query}/JSON`;
            } else {
                return `https://pubchem.ncbi.nlm.nih.gov/rest/pug/substance/name/${encodeURIComponent(query)}/sids/JSON?name_type=word`;
            }
        },
        resultUrl: (id) => `https://pubchem.ncbi.nlm.nih.gov/substance/${id}`
    },
    pubchem_literature: {
        name: 'PubChem Literature',
        description: 'Scientific literature related to chemical compounds from PubMed.',
        hidden: true, // Don't show in database list, it's part of PubChem
        searchUrl: (query) => {
            // Use PubChem's literature search via SDQAGENT
            return `https://pubchem.ncbi.nlm.nih.gov/sdq/sdqagent.cgi?infmt=json&outfmt=json&query={"select":"*","collection":"pubmed","where":{"ands":[{"*":"${encodeURIComponent(query)}"}]},"start":1,"limit":10}`;
        },
        resultUrl: (id) => `https://pubmed.ncbi.nlm.nih.gov/${id}`
    },
    uniprot: {
        name: 'UniProt',
        description: 'Universal Protein Resource - Comprehensive protein sequence and functional information.',
        examples: ['P12345', 'Q9Y6K9', 'O15552', 'insulin'],
        placeholder: 'Enter UniProt ID or protein name',
        searchUrl: (query) => `https://rest.uniprot.org/uniprotkb/search?query=${encodeURIComponent(query)}&format=json&size=10&fields=accession,protein_name,gene_names,organism_name,length,cc_function,sequence,xref_pdb,xref_alphafolddb`,
        resultUrl: (id) => `https://www.uniprot.org/uniprotkb/${id}`
    },
    chembl: {
        name: 'ChEMBL',
        description: 'Database of bioactive drug-like small molecules with drug discovery information.',
        examples: ['CHEMBL25', 'CHEMBL1', 'aspirin', 'ibuprofen'],
        placeholder: 'Enter ChEMBL ID or drug name',
        searchUrl: (query) => {
            const isChemblId = query.toUpperCase().startsWith('CHEMBL');
            if (isChemblId) {
                return `https://www.ebi.ac.uk/chembl/api/data/molecule/${query.toUpperCase()}.json`;
            } else {
                return `https://www.ebi.ac.uk/chembl/api/data/molecule/search.json?q=${encodeURIComponent(query)}`;
            }
        },
        resultUrl: (id) => `https://www.ebi.ac.uk/chembl/compound_report_card/${id}/`
    }
};

// DOM Elements
const searchInput = document.getElementById('search-input');
const searchBtn = document.getElementById('search-btn');
const resultsSection = document.getElementById('results-section');
const loading = document.getElementById('loading');
const resultsContainer = document.getElementById('results-container');
const searchStats = document.getElementById('search-stats');
const actionButtons = document.getElementById('action-buttons');
const selectAllBtn = document.getElementById('select-all-btn');
const deselectAllBtn = document.getElementById('deselect-all-btn');
const useSelectedBtn = document.getElementById('use-selected-btn');

let selectedItems = new Set();
let allResults = [];

// Event Listeners
searchInput.addEventListener('keypress', handleKeyPress);
searchBtn.addEventListener('click', handleSearch);
selectAllBtn.addEventListener('click', selectAll);
deselectAllBtn.addEventListener('click', deselectAll);
useSelectedBtn.addEventListener('click', useSelectedItems);

// Update selected items count
function updateSelectedCount() {
    useSelectedBtn.textContent = `Use Selected Items (${selectedItems.size})`;
    useSelectedBtn.disabled = selectedItems.size === 0;
}

// Select all checkboxes
function selectAll() {
    document.querySelectorAll('.result-checkbox').forEach(cb => {
        cb.checked = true;
        selectedItems.add(cb.dataset.resultId);
    });
    updateSelectedCount();
}

// Deselect all checkboxes
function deselectAll() {
    document.querySelectorAll('.result-checkbox').forEach(cb => {
        cb.checked = false;
    });
    selectedItems.clear();
    updateSelectedCount();
}

// Use selected items (for Part 2)
function useSelectedItems() {
    const selected = saveSearchState();
    console.log('Selected items for Part 2:', selected);

    if (typeof window.switchAppView === 'function') {
        window.switchAppView('review');
        return;
    }

    window.location.href = 'review.html';
}

// Handle Enter key press
function handleKeyPress(e) {
    if (e.key === 'Enter' && !searchBtn.disabled) {
        handleSearch();
    }
}

// Main search handler - searches all databases
async function handleSearch() {
    const query = searchInput.value.trim();
    
    if (!query) {
        alert('Please enter a search query');
        return;
    }
    
    // Reset state
    selectedItems.clear();
    allResults = [];
    
    // Show loading state
    resultsSection.classList.remove('hidden');
    loading.classList.remove('hidden');
    resultsContainer.innerHTML = '';
    actionButtons.classList.add('hidden');
    searchStats.innerHTML = '';
    
    const results = [];
    const dbKeys = Object.keys(databases);
    
    // Search all databases in parallel
    const promises = dbKeys.map(async (dbKey) => {
        try {
            const result = await searchDatabase(dbKey, query);
            return { dbKey, success: true, data: result };
        } catch (error) {
            console.error(`${dbKey}: Search failed`, error.message);
            return { dbKey, success: false, error: error.message };
        }
    });
    
    const searchResults = await Promise.all(promises);
    
    loading.classList.add('hidden');
    
    // Display results from all databases
    let totalResults = 0;
    let successfulDatabases = 0;
    
    for (const result of searchResults) {
        if (result.success) {
            const resultCount = await displayResults(result.data, result.dbKey, query);
            if (resultCount > 0) {
                totalResults += resultCount;
                successfulDatabases++;
            }
        }
    }
    
    // Show statistics
    searchStats.innerHTML = `
        <p><strong>Search completed:</strong> Found ${totalResults} results across ${successfulDatabases} database(s)</p>
    `;
    
    if (totalResults > 0) {
        actionButtons.classList.remove('hidden');
        updateSelectedCount();
    } else {
        displayNoResults();
    }
}

async function fetchSearchApi(path, payload) {
    const response = await fetch(path, {
        method: 'POST',
        headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload || {})
    });

    const rawText = await response.text();
    const parsedBody = rawText ? JSON.parse(rawText) : {};

    if (!response.ok) {
        throw new Error(parsedBody.error || `HTTP ${response.status}`);
    }

    return parsedBody;
}

// Search database function
async function searchDatabase(dbKey, query) {
    const db = databases[dbKey];
    
    try {
        const response = await fetchSearchApi('/api/search', { dbKey, query });
        return { data: response.data, dbKey, query };
    } catch (error) {
        throw new Error(`Error searching ${db.name}: ${error.message}`);
    }
}

// Display results based on database type
async function displayResults(result, dbKey, query) {
    const db = databases[dbKey];
    let resultCount = 0;
    
    try {
        switch (dbKey) {
            case 'alphafold':
                resultCount = displayAlphaFoldResults(result.data, db, dbKey);
                break;
            case 'pdb':
                resultCount = await displayPDBResults(result.data, db, query, dbKey);
                break;
            case 'kegg':
                resultCount = displayKEGGResults(result.data, db, query, dbKey);
                break;
            case 'pubchem':
                resultCount = await displayPubChemResults(result.data, db, dbKey);
                break;
            case 'pubchem_substances':
                resultCount = await displayPubChemSubstancesResults(result.data, db, dbKey);
                break;
            case 'pubchem_literature':
                resultCount = displayPubChemLiteratureResults(result.data, db, dbKey);
                break;
            case 'uniprot':
                resultCount = displayUniProtResults(result.data, db, dbKey);
                break;
            case 'chembl':
                resultCount = displayChEMBLResults(result.data, db, query, dbKey);
                break;
            default:
                resultCount = displayGenericResults(result.data, db, query, dbKey);
        }
    } catch (error) {
        console.error(`Error parsing ${db.name} results:`, error);
    }
    
    return resultCount;
}

// AlphaFold results display
function displayAlphaFoldResults(data, db, dbKey) {
    if (!data || !data.results || data.results.length === 0) return 0;
    
    let count = 0;
    data.results.slice(0, 5).forEach(entry => {
        const proteinName = entry.proteinDescription?.recommendedName?.fullName?.value || 'Protein Structure';
        const organism = entry.organism?.scientificName || 'Unknown organism';
        const gene = entry.genes?.[0]?.geneName?.value || '';
        const functionDesc = entry.comments?.find(c => c.commentType === 'FUNCTION')?.texts?.[0]?.value || '';
        
        const resultData = {
            id: `${dbKey}-${entry.primaryAccession}`,
            database: db.name,
            title: `${entry.primaryAccession} - ${proteinName}`,
            description: functionDesc || `${proteinName} from ${organism}${gene ? ` (Gene: ${gene})` : ''}`,
            type: 'protein',
            organism: organism,
            data: entry,
            url: db.resultUrl(entry.primaryAccession)
        };
        allResults.push(resultData);
        
        const card = createResultCard({
            id: resultData.id,
            database: db.name,
            title: resultData.title,
            description: resultData.description,
            items: [
                { label: 'Organism', value: organism },
                { label: 'Gene', value: gene },
                { label: 'Length', value: entry.sequence?.length ? `${entry.sequence.length} aa` : 'N/A' },
                { label: 'UniProt ID', value: entry.primaryAccession }
            ],
            link: resultData.url,
            linkText: 'View Structure in AlphaFold',
            type: resultData.type
        });
        
        resultsContainer.appendChild(card);
        count++;
    });
    
    return count;
}

// PDB results display - fetches additional details for each entry
async function displayPDBResults(data, db, query, dbKey) {
    // Handle search API response format
    if (!data.result_set || data.result_set.length === 0) return 0;
    
    let count = 0;
    const pdbIds = data.result_set.slice(0, 10).map(r => r.identifier);
    
    // Fetch details for all PDB entries in one request
    let detailsMap = {};
    try {
        const detailsResponse = await fetchSearchApi('/api/search/pdb-details', { pdbIds });
        const detailsData = detailsResponse.data;
        if (detailsData.data && detailsData.data.entries) {
            detailsData.data.entries.forEach(entry => {
                if (entry) detailsMap[entry.rcsb_id] = entry;
            });
        }
    } catch (error) {
        console.error('Error fetching PDB details:', error);
    }
    
    data.result_set.slice(0, 10).forEach(result => {
        const pdbId = result.identifier;
        const details = detailsMap[pdbId] || {};
        
        // Extract title
        const title = details.struct?.title || 'Structure';
        
        // Extract organism
        let organism = 'Unknown';
        if (details.polymer_entities && details.polymer_entities.length > 0) {
            const source = details.polymer_entities[0]?.rcsb_entity_source_organism;
            if (source && source.length > 0) {
                organism = source[0].scientific_name || 'Unknown';
            }
        }
        
        // Extract description from polymer entities
        let description = '';
        if (details.polymer_entities && details.polymer_entities.length > 0) {
            const descs = details.polymer_entities
                .map(pe => pe?.rcsb_polymer_entity?.pdbx_description)
                .filter(d => d);
            description = descs.join(', ');
        }
        
        // Extract experimental info
        const info = details.rcsb_entry_info || {};
        const method = info.experimental_method || 'Unknown';
        const resolution = info.resolution_combined ? 
            (Array.isArray(info.resolution_combined) ? info.resolution_combined[0] : info.resolution_combined) : null;
        
        const resultData = {
            id: `${dbKey}-${pdbId}`,
            database: db.name,
            title: `${pdbId} - ${title}`,
            description: description || title,
            type: 'structure',
            organism: organism,
            method: method,
            resolution: resolution,
            data: result,
            url: db.resultUrl(pdbId)
        };
        allResults.push(resultData);
        
        const items = [
            { label: 'PDB ID', value: pdbId },
            { label: 'Organism', value: organism },
            { label: 'Method', value: method },
            { label: 'Resolution', value: resolution ? `${resolution.toFixed(2)} Å` : 'N/A' }
        ];
        
        const card = createResultCard({
            id: resultData.id,
            database: db.name,
            title: resultData.title,
            description: description || `${method} structure from ${organism}`,
            items: items,
            link: resultData.url,
            linkText: 'View in PDB',
            type: resultData.type
        });
        
        resultsContainer.appendChild(card);
        count++;
    });
    
    return count;
}

// KEGG results display
function displayKEGGResults(data, db, query, dbKey) {
    // Handle empty data
    if (!data || data.trim() === '') {
        console.log('KEGG: No data to display');
        return 0;
    }
    
    const lines = data.split('\n').filter(line => line.trim());
    
    // Check if we have any lines
    if (lines.length === 0) {
        console.log('KEGG: No lines in response');
        return 0;
    }
    
    // Check if this is a search result (tab-separated) or a direct entry (flat file)
    const isSearchResult = lines.length > 0 && lines[0].includes('\t') && !lines[0].startsWith('ENTRY');
    
    console.log('KEGG parsing mode:', isSearchResult ? 'search results' : 'direct entry');
    console.log('KEGG first line:', lines[0]);
    
    if (isSearchResult) {
        // Parse search results (format: "cpd:C00780\tSerotonin; 5-Hydroxytryptamine")
        let count = 0;
        lines.slice(0, 15).forEach(line => {
            const parts = line.split('\t');
            if (parts.length >= 2) {
                const fullId = parts[0].trim(); // e.g., "cpd:C00780" or "path:hsa00010"
                const description = parts[1].trim();
                
                // Extract the actual KEGG ID
                const idMatch = fullId.match(/^[a-z]+:(.+)$/i);
                const keggId = idMatch ? idMatch[1] : fullId;
                
                // Determine type from prefix
                let entryType = 'compound';
                if (fullId.startsWith('path:')) entryType = 'pathway';
                else if (fullId.startsWith('dr:')) entryType = 'drug';
                else if (fullId.startsWith('cpd:')) entryType = 'compound';
                
                // Get name from description (first part before semicolon)
                const name = description.split(';')[0].trim();
                
                const resultData = {
                    id: `${dbKey}-${keggId}`,
                    database: db.name,
                    title: `${keggId} - ${name}`,
                    description: description,
                    type: entryType,
                    data: { ENTRY: fullId, NAME: name, DESCRIPTION: description },
                    url: db.resultUrl(keggId)
                };
                allResults.push(resultData);
                
                const card = createResultCard({
                    id: resultData.id,
                    database: db.name,
                    title: resultData.title,
                    description: description,
                    items: [
                        { label: 'KEGG ID', value: keggId },
                        { label: 'Type', value: entryType.charAt(0).toUpperCase() + entryType.slice(1) }
                    ],
                    link: resultData.url,
                    linkText: 'View in KEGG',
                    type: resultData.type
                });
                
                resultsContainer.appendChild(card);
                count++;
            }
        });
        return count;
    } else {
        // Parse direct entry (flat file format)
        const info = {};
        let currentKey = '';
        
        lines.forEach(line => {
            if (line.match(/^[A-Z]/)) {
                const match = line.match(/^([A-Z_]+)\s+(.+)/);
                if (match) {
                    currentKey = match[1];
                    info[currentKey] = match[2];
                }
            } else if (currentKey && line.trim()) {
                info[currentKey] += ' ' + line.trim();
            }
        });
        
        const description = info.DEFINITION || info.DESCRIPTION || `KEGG entry for ${info.NAME || query}`;
        
        const resultData = {
            id: `${dbKey}-${query}`,
            database: db.name,
            title: info.NAME || query,
            description: description,
            type: 'pathway',
            data: info,
            url: db.resultUrl(query)
        };
        allResults.push(resultData);
        
        const card = createResultCard({
            id: resultData.id,
            database: db.name,
            title: resultData.title,
            description: description,
            items: [
                { label: 'Entry', value: info.ENTRY },
                { label: 'Class', value: info.CLASS },
                { label: 'Pathway', value: info.PATHWAY }
            ].filter(item => item.value),
            link: resultData.url,
            linkText: 'View in KEGG',
            type: resultData.type
        });
        
        resultsContainer.appendChild(card);
        return 1;
    }
}

// PubChem results display
async function displayPubChemResults(data, db, dbKey) {
    console.log('PubChem data received:', data);
    
    // Handle CID list from name search
    if (data.IdentifierList && data.IdentifierList.CID) {
        const allCids = data.IdentifierList.CID;
        console.log(`PubChem: Found ${allCids.length} CIDs, showing first 10`);
        const cids = allCids.slice(0, 10); // First 10 results
        
        // Fetch properties for all CIDs in one request
        try {
            const response = await fetchSearchApi('/api/search/pubchem-properties', { cids });
            const propData = response.data;
            console.log('PubChem properties received:', propData);

            if (!propData.PropertyTable || !propData.PropertyTable.Properties) {
                console.error('PubChem: No PropertyTable in response');
                return 0;
            }
            
            console.log(`PubChem: Got properties for ${propData.PropertyTable.Properties.length} compounds`);
            let count = 0;
            propData.PropertyTable.Properties.forEach(props => {
                const cid = props.CID;
                
                const resultData = {
                    id: `${dbKey}-${cid}`,
                    database: db.name,
                    title: `${props.Title || 'Compound'} (CID: ${cid})`,
                    description: `${props.Title || 'Compound'}${props.MolecularFormula ? ` • Formula: ${props.MolecularFormula}` : ''}`,
                    type: 'compound',
                    data: { cid, ...props },
                    url: db.resultUrl(cid)
                };
                allResults.push(resultData);
                
                const card = createResultCard({
                    id: resultData.id,
                    database: db.name,
                    title: resultData.title,
                    description: `Chemical compound with molecular formula ${props.MolecularFormula || 'N/A'}`,
                    items: [
                        { label: 'Molecular Formula', value: props.MolecularFormula },
                        { label: 'Molecular Weight', value: props.MolecularWeight },
                        { label: 'SMILES', value: props.CanonicalSMILES },
                        { label: 'InChI Key', value: props.InChIKey }
                    ].filter(item => item.value),
                    link: resultData.url,
                    linkText: 'View in PubChem',
                    type: resultData.type
                });
                
                resultsContainer.appendChild(card);
                count++;
            });
            
            return count;
        } catch (error) {
            console.error('Error fetching PubChem properties:', error);
            return 0;
        }
    }
    
    // Handle PropertyTable format (direct CID search)
    if (data.PropertyTable && data.PropertyTable.Properties) {
        const props = data.PropertyTable.Properties[0];
        const cid = props.CID;
        
        const resultData = {
            id: `${dbKey}-${cid}`,
            database: db.name,
            title: `${props.Title || 'Compound'} (CID: ${cid})`,
            description: `${props.Title}${props.MolecularFormula ? ` • Formula: ${props.MolecularFormula}` : ''}`,
            type: 'compound',
            data: { cid, ...props },
            url: db.resultUrl(cid)
        };
        allResults.push(resultData);
        
        const card = createResultCard({
            id: resultData.id,
            database: db.name,
            title: resultData.title,
            description: `Chemical compound with molecular formula ${props.MolecularFormula || 'N/A'}`,
            items: [
                { label: 'Molecular Formula', value: props.MolecularFormula },
                { label: 'Molecular Weight', value: props.MolecularWeight },
                { label: 'SMILES', value: props.CanonicalSMILES },
                { label: 'InChI Key', value: props.InChIKey }
            ].filter(item => item.value),
            link: resultData.url,
            linkText: 'View in PubChem',
            type: resultData.type
        });
        
        resultsContainer.appendChild(card);
        return 1;
    }
    
    return 0;
}

// PubChem Substances display
async function displayPubChemSubstancesResults(data, db, dbKey) {
    console.log('PubChem Substances data:', data);
    
    // Handle SID list from name search
    if (data.IdentifierList && data.IdentifierList.SID) {
        const allSids = data.IdentifierList.SID;
        console.log(`PubChem Substances: Found ${allSids.length} SIDs, showing first 10`);
        const sids = allSids.slice(0, 10); // First 10 results
        
        let count = 0;
        for (const sid of sids) {
            const resultData = {
                id: `${dbKey}-${sid}`,
                database: db.name,
                title: `Substance SID: ${sid}`,
                description: `PubChem substance record`,
                type: 'substance',
                data: { sid },
                url: db.resultUrl(sid)
            };
            allResults.push(resultData);
            
            const card = createResultCard({
                id: resultData.id,
                database: db.name,
                title: resultData.title,
                description: `Chemical substance record from data depositors`,
                items: [
                    { label: 'SID', value: sid.toString() }
                ],
                link: resultData.url,
                linkText: 'View in PubChem',
                type: resultData.type
            });
            
            resultsContainer.appendChild(card);
            count++;
        }
        
        return count;
    }
    
    // Handle direct SID lookup
    if (data.PC_Substances) {
        let count = 0;
        data.PC_Substances.slice(0, 10).forEach(substance => {
            const sid = substance.sid?.id?.id;
            if (!sid) return;
            
            const sourceName = substance.source?.db?.name || 'Unknown source';
            
            const resultData = {
                id: `${dbKey}-${sid}`,
                database: db.name,
                title: `Substance SID: ${sid}`,
                description: `From: ${sourceName}`,
                type: 'substance',
                data: { sid, ...substance },
                url: db.resultUrl(sid)
            };
            allResults.push(resultData);
            
            const card = createResultCard({
                id: resultData.id,
                database: db.name,
                title: resultData.title,
                description: `Chemical substance from ${sourceName}`,
                items: [
                    { label: 'SID', value: sid.toString() },
                    { label: 'Source', value: sourceName }
                ],
                link: resultData.url,
                linkText: 'View in PubChem',
                type: resultData.type
            });
            
            resultsContainer.appendChild(card);
            count++;
        });
        
        return count;
    }
    
    return 0;
}

// PubChem Literature display
function displayPubChemLiteratureResults(data, db, dbKey) {
    console.log('PubChem Literature data:', data);
    
    // Handle SDQ response format
    if (data.SDQOutputSet && data.SDQOutputSet.length > 0) {
        const rows = data.SDQOutputSet[0]?.rows || [];
        console.log(`PubChem Literature: Found ${rows.length} articles`);
        
        if (rows.length === 0) return 0;
        
        let count = 0;
        rows.slice(0, 10).forEach(article => {
            const pmid = article.pmid;
            const title = article.articletitle || 'Untitled';
            const journal = article.journalname || '';
            const year = article.articledate || article.pubdate || '';
            const authors = article.authors || '';
            
            const resultData = {
                id: `${dbKey}-${pmid}`,
                database: db.name,
                title: title,
                description: `${journal}${year ? ` (${year})` : ''}`,
                type: 'literature',
                data: article,
                url: db.resultUrl(pmid)
            };
            allResults.push(resultData);
            
            const card = createResultCard({
                id: resultData.id,
                database: db.name,
                title: resultData.title,
                description: `Scientific literature from PubMed`,
                items: [
                    { label: 'PMID', value: pmid?.toString() },
                    { label: 'Journal', value: journal },
                    { label: 'Year', value: year },
                    { label: 'Authors', value: authors.length > 100 ? authors.substring(0, 100) + '...' : authors }
                ].filter(item => item.value),
                link: resultData.url,
                linkText: 'View in PubMed',
                type: resultData.type
            });
            
            resultsContainer.appendChild(card);
            count++;
        });
        
        return count;
    }
    
    return 0;
}

// UniProt results display
function displayUniProtResults(data, db, dbKey) {
    const results = data.results;
    
    if (!results || results.length === 0) return 0;
    
    let count = 0;
    results.slice(0, 10).forEach(entry => {
        const proteinName = entry.proteinDescription?.recommendedName?.fullName?.value || 'Protein';
        const organism = entry.organism?.scientificName || 'Unknown';
        const gene = entry.genes?.[0]?.geneName?.value || '';
        const functionDesc = entry.comments?.find(c => c.commentType === 'FUNCTION')?.texts?.[0]?.value || '';
        
        // Check for 3D structure availability
        const crossRefs = entry.uniProtKBCrossReferences || [];
        const hasPDB = crossRefs.some(ref => ref.database === 'PDB');
        const hasAlphaFold = crossRefs.some(ref => ref.database === 'AlphaFoldDB');
        const has3DStructure = hasPDB || hasAlphaFold;
        const structureSource = hasPDB ? 'PDB' : (hasAlphaFold ? 'AlphaFold' : null);
        
        const description = functionDesc || `${proteinName} from ${organism}${gene ? ` (Gene: ${gene})` : ''}`;
        
        const resultData = {
            id: `${dbKey}-${entry.primaryAccession}`,
            database: db.name,
            title: `${entry.primaryAccession} - ${proteinName}`,
            description: description,
            type: 'protein',
            organism: organism,
            has3DStructure: has3DStructure,
            structureSource: structureSource,
            data: entry,
            url: db.resultUrl(entry.primaryAccession)
        };
        allResults.push(resultData);
        
        const card = createResultCard({
            id: resultData.id,
            database: db.name,
            title: resultData.title,
            description: description,
            items: [
                { label: 'Protein Name', value: proteinName },
                { label: 'Organism', value: organism },
                { label: 'Gene', value: gene },
                { label: 'Length', value: entry.sequence?.length ? `${entry.sequence.length} aa` : 'N/A' }
            ].filter(item => item.value),
            link: resultData.url,
            linkText: 'View in UniProt',
            type: resultData.type,
            has3DStructure: has3DStructure,
            structureSource: structureSource
        });
        
        resultsContainer.appendChild(card);
        count++;
    });
    
    return count;
}

// ChEMBL results display
function displayChEMBLResults(data, db, query, dbKey) {
    const molecules = data.molecules || [data];
    
    if (!molecules || molecules.length === 0) return 0;
    
    let count = 0;
    molecules.slice(0, 10).forEach(mol => {
        const name = mol.pref_name || mol.molecule_chembl_id;
        const type = mol.molecule_type || 'Small molecule';
        const phase = mol.max_phase !== undefined ? mol.max_phase : 'N/A';
        const formula = mol.molecule_properties?.full_molformula || '';
        
        const description = `${type}${phase !== 'N/A' ? ` • Clinical Phase ${phase}` : ''}${formula ? ` • Formula: ${formula}` : ''}`;
        
        const resultData = {
            id: `${dbKey}-${mol.molecule_chembl_id}`,
            database: db.name,
            title: name,
            description: description,
            type: 'compound',
            data: mol,
            url: db.resultUrl(mol.molecule_chembl_id)
        };
        allResults.push(resultData);
        
        const card = createResultCard({
            id: resultData.id,
            database: db.name,
            title: resultData.title,
            description: description,
            items: [
                { label: 'ChEMBL ID', value: mol.molecule_chembl_id },
                { label: 'Type', value: type },
                { label: 'Max Phase', value: phase !== 'N/A' ? `Phase ${phase}` : 'N/A' },
                { label: 'Molecular Formula', value: formula }
            ].filter(item => item.value),
            link: resultData.url,
            linkText: 'View in ChEMBL',
            type: resultData.type
        });
        
        resultsContainer.appendChild(card);
        count++;
    });
    
    return count;
}

// Helper function to create result card
function createResultCard({ id, database, title, description, items, link, linkText, type, has3DStructure, structureSource }) {
    const card = document.createElement('div');
    card.className = 'result-card';
    card.dataset.database = database;
    card.dataset.type = type || 'unknown';
    
    // Add checkbox
    const checkboxContainer = document.createElement('div');
    checkboxContainer.className = 'checkbox-container';
    
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'result-checkbox';
    checkbox.id = `cb-${id}`;
    checkbox.dataset.resultId = id;
    
    checkbox.addEventListener('change', (e) => {
        if (e.target.checked) {
            selectedItems.add(id);
        } else {
            selectedItems.delete(id);
        }
        updateSelectedCount();
        saveSearchState(); // Auto-save on selection change
    });
    
    const checkboxLabel = document.createElement('label');
    checkboxLabel.htmlFor = `cb-${id}`;
    checkboxLabel.className = 'checkbox-label';
    checkboxLabel.textContent = 'Select for analysis';
    
    checkboxContainer.appendChild(checkbox);
    checkboxContainer.appendChild(checkboxLabel);
    
    // Add database badge with database-specific class
    const badge = document.createElement('span');
    const dbClass = database.toLowerCase().replace(/[^a-z]/g, '');
    badge.className = `database-badge ${dbClass}`;
    badge.textContent = database;
    
    const header = document.createElement('div');
    header.className = 'result-header';
    header.appendChild(checkboxContainer);
    header.appendChild(badge);
    
    // Add 3D structure badge if available
    if (has3DStructure) {
        const badge3D = document.createElement('span');
        badge3D.className = 'structure-badge has-3d';
        badge3D.textContent = `3D Available (${structureSource})`;
        badge3D.title = `3D structure available from ${structureSource}`;
        header.appendChild(badge3D);
    }
    
    card.appendChild(header);
    
    const titleElem = document.createElement('h3');
    titleElem.textContent = title;
    card.appendChild(titleElem);
    
    // Add description if provided
    if (description) {
        const descElem = document.createElement('p');
        descElem.className = 'result-description';
        descElem.textContent = description;
        card.appendChild(descElem);
    }
    
    items.forEach(item => {
        if (item.value) {
            const p = document.createElement('p');
            p.innerHTML = `<strong>${item.label}:</strong> ${item.value}`;
            card.appendChild(p);
        }
    });
    
    if (link) {
        const linkElem = document.createElement('a');
        linkElem.href = link;
        linkElem.target = '_blank';
        linkElem.className = 'result-link';
        linkElem.textContent = linkText || 'View Details →';
        card.appendChild(linkElem);
    }
    
    return card;
}

// Display error message
function displayError(message) {
    resultsContainer.innerHTML = `
        <div class="error-message">
            <strong>⚠️ Error:</strong> ${message}
        </div>
    `;
}

// Display no results message
function displayNoResults() {
    resultsContainer.innerHTML = `
        <div class="no-results">
            <p>No results found. Try a different search query.</p>
        </div>
    `;
}

// Generic results display
function displayGenericResults(data, db, query, dbKey) {
    const resultData = {
        id: `${dbKey}-${query}`,
        database: db.name,
        title: `Results for "${query}"`,
        type: 'unknown',
        data: data,
        url: db.resultUrl(query)
    };
    allResults.push(resultData);
    
    const card = createResultCard({
        id: resultData.id,
        database: db.name,
        title: resultData.title,
        items: [
            { label: 'Database', value: db.name },
            { label: 'Query', value: query },
            { label: 'Status', value: 'Data retrieved successfully' }
        ],
        link: resultData.url,
        linkText: 'View Full Details',
        type: resultData.type
    });
    
    resultsContainer.appendChild(card);
    return 1;
}

// ================================================
// Window Management & Sync Functions
// ================================================

let reviewWindow = null;

function notifySelectionChanged(selected) {
    window.SearchWorkspaceModule.notifySelectionChanged(selected);
}

// Open Review window - navigate directly
function openReviewWindow() {
    window.SearchWorkspaceModule.openReviewView(saveSearchState);
}

// Save search state to localStorage
function saveSearchState() {
    return window.SearchWorkspaceModule.persistSearchState({
        query: searchInput.value,
        results: allResults,
        selectedIds: Array.from(selectedItems)
    });
}

// Load search state from localStorage
function loadSearchState() {
    const state = window.SearchWorkspaceModule.readSearchState();
    if (!state) {
        return;
    }

    if (state.query) {
        searchInput.value = state.query;
    }
    if (state.results && state.results.length > 0) {
        allResults = state.results;
        selectedItems = new Set(state.selected || []);
        displaySavedResults();
    }
}

// Display saved results from localStorage
function displaySavedResults() {
    if (allResults.length === 0) return;
    
    resultsSection.classList.remove('hidden');
    loading.classList.add('hidden');
    actionButtons.classList.remove('hidden');
    
    // Group results by database
    const groupedResults = {};
    allResults.forEach(result => {
        const db = result.database || 'Unknown';
        if (!groupedResults[db]) {
            groupedResults[db] = [];
        }
        groupedResults[db].push(result);
    });
    
    // Display stats
    const dbCounts = Object.entries(groupedResults)
        .map(([db, results]) => `${db}: ${results.length}`)
        .join(' | ');
    searchStats.innerHTML = `<strong>${allResults.length}</strong> results found | ${dbCounts}`;
    
    // Display result cards
    resultsContainer.innerHTML = '';
    allResults.forEach(result => {
        const card = createSavedResultCard(result);
        resultsContainer.appendChild(card);
    });
    
    updateSelectedCount();
}

// Create result card (simplified version for saved results)
function createSavedResultCard(result) {
    const card = document.createElement('div');
    card.className = 'result-card';
    card.dataset.database = result.database;
    card.dataset.type = result.type || 'unknown';
    
    const isChecked = selectedItems.has(result.id);
    
    // Build 3D badge HTML if available
    const badge3DHTML = result.has3DStructure 
        ? `<span class="structure-badge has-3d" title="3D structure available from ${result.structureSource}">3D Available (${result.structureSource})</span>` 
        : '';
    
    card.innerHTML = `
        <div class="result-checkbox-container">
            <input type="checkbox" class="result-checkbox" 
                   data-result-id="${result.id}" 
                   id="cb-${result.id}"
                   ${isChecked ? 'checked' : ''}>
            <label for="cb-${result.id}"></label>
        </div>
        <div class="result-content">
            <div class="result-header">
                <span class="database-badge ${result.database.toLowerCase().replace(/[^a-z]/g, '')}">${result.database}</span>
                ${badge3DHTML}
                <h3 class="result-title">${result.title || result.id}</h3>
            </div>
            <p class="result-description">${result.description || 'No description available'}</p>
            <div class="result-meta">
                <span class="result-id">ID: ${result.id}</span>
                ${result.link ? `<a href="${result.link}" target="_blank" class="result-link">${result.linkText || 'View Details'}</a>` : ''}
            </div>
        </div>
    `;
    
    // Add checkbox listener
    const checkbox = card.querySelector('.result-checkbox');
    checkbox.addEventListener('change', (e) => {
        if (e.target.checked) {
            selectedItems.add(result.id);
        } else {
            selectedItems.delete(result.id);
        }
        updateSelectedCount();
        saveSearchState(); // Auto-save on selection change
    });
    
    return card;
}

// Save state before leaving the page
window.addEventListener('beforeunload', () => {
    if (allResults.length > 0) {
        saveSearchState();
    }
});

// ====== FILTER FUNCTIONALITY ======
let currentFilter = {
    databases: new Set(['all']), // Track which databases are enabled (empty = show all)
    type: 'all',
    text: '',
    sort: 'relevance'
};

// Initialize filter controls
function initFilterControls() {
    const dbFilters = document.getElementById('db-filters');
    const sortSelect = document.getElementById('sort-select');
    const typeSelect = document.getElementById('type-select');
    const resultFilter = document.getElementById('result-filter');
    
    if (!dbFilters) return; // Not on search page
    
    // Database filter buttons - independent toggles
    dbFilters.addEventListener('click', (e) => {
        if (e.target.classList.contains('filter-btn')) {
            const filter = e.target.dataset.filter;
            
            if (filter === 'all') {
                // "All" button - show everything and deactivate other buttons
                currentFilter.databases = new Set(['all']);
                dbFilters.querySelectorAll('.filter-btn').forEach(btn => {
                    btn.classList.toggle('active', btn.dataset.filter === 'all');
                });
            } else {
                // Individual database toggle
                // Remove 'all' from the set if it's there
                currentFilter.databases.delete('all');
                dbFilters.querySelector('[data-filter="all"]').classList.remove('active');
                
                // Toggle this database
                if (currentFilter.databases.has(filter)) {
                    currentFilter.databases.delete(filter);
                    e.target.classList.remove('active');
                } else {
                    currentFilter.databases.add(filter);
                    e.target.classList.add('active');
                }
                
                // If no databases selected, revert to "All"
                if (currentFilter.databases.size === 0) {
                    currentFilter.databases.add('all');
                    dbFilters.querySelector('[data-filter="all"]').classList.add('active');
                }
            }
            
            applyFilters();
        }
    });
    
    // Sort dropdown
    if (sortSelect) {
        sortSelect.addEventListener('change', (e) => {
            currentFilter.sort = e.target.value;
            applyFilters();
        });
    }
    
    // Type dropdown
    if (typeSelect) {
        typeSelect.addEventListener('change', (e) => {
            currentFilter.type = e.target.value;
            applyFilters();
        });
    }
    
    // Text filter with debounce
    if (resultFilter) {
        let debounceTimer;
        resultFilter.addEventListener('input', (e) => {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                currentFilter.text = e.target.value.toLowerCase().trim();
                applyFilters();
            }, 200);
        });
    }
}

// Apply all active filters
function applyFilters() {
    const cards = document.querySelectorAll('.result-card');
    let visibleCount = 0;
    
    cards.forEach(card => {
        let visible = true;
        
        // Get card data
        const database = card.dataset.database || '';
        const type = card.dataset.type || '';
        const title = (card.querySelector('h3')?.textContent || '').toLowerCase();
        const description = (card.querySelector('.result-description')?.textContent || '').toLowerCase();
        const fullText = title + ' ' + description;
        
        // Database filter - check if any of the enabled databases match
        if (!currentFilter.databases.has('all')) {
            const dbLower = database.toLowerCase();
            let matchesAnyDb = false;
            for (const enabledDb of currentFilter.databases) {
                if (dbLower.includes(enabledDb.toLowerCase())) {
                    matchesAnyDb = true;
                    break;
                }
            }
            if (!matchesAnyDb) {
                visible = false;
            }
        }
        
        // Type filter
        if (visible && currentFilter.type !== 'all') {
            if (type !== currentFilter.type) {
                visible = false;
            }
        }
        
        // Text filter
        if (visible && currentFilter.text) {
            if (!fullText.includes(currentFilter.text)) {
                visible = false;
            }
        }
        
        // Show/hide card
        card.style.display = visible ? '' : 'none';
        if (visible) visibleCount++;
    });
    
    // Apply sorting
    sortVisibleCards();
    
    // Update count display
    updateFilterCount(visibleCount, cards.length);
}

// Sort the visible cards
function sortVisibleCards() {
    const container = document.getElementById('results-container');
    if (!container) return;
    
    const cards = Array.from(container.querySelectorAll('.result-card'));
    
    cards.sort((a, b) => {
        const titleA = (a.querySelector('h3')?.textContent || '').toLowerCase();
        const titleB = (b.querySelector('h3')?.textContent || '').toLowerCase();
        const dbA = (a.dataset.database || '').toLowerCase();
        const dbB = (b.dataset.database || '').toLowerCase();
        
        switch (currentFilter.sort) {
            case 'name-asc':
                return titleA.localeCompare(titleB);
            case 'name-desc':
                return titleB.localeCompare(titleA);
            case 'database':
                return dbA.localeCompare(dbB) || titleA.localeCompare(titleB);
            case 'relevance':
            default:
                // Keep original order (order added to DOM)
                return 0;
        }
    });
    
    // Only re-order if not relevance
    if (currentFilter.sort !== 'relevance') {
        cards.forEach(card => container.appendChild(card));
    }
}

// Update filter count display
function updateFilterCount(visible, total) {
    const statsEl = document.getElementById('search-stats');
    if (statsEl && visible < total) {
        // Show filtered count
        const existingFilter = statsEl.querySelector('.filter-count');
        if (existingFilter) {
            existingFilter.textContent = `Showing ${visible} of ${total} results`;
        } else {
            const filterSpan = document.createElement('span');
            filterSpan.className = 'filter-count';
            filterSpan.textContent = `Showing ${visible} of ${total} results`;
            filterSpan.style.marginLeft = '15px';
            filterSpan.style.color = '#a78bfa';
            statsEl.appendChild(filterSpan);
        }
    } else if (statsEl) {
        // Remove filter count if all visible
        const existingFilter = statsEl.querySelector('.filter-count');
        if (existingFilter) existingFilter.remove();
    }
}

// Reset filters
function resetFilters() {
    currentFilter = {
        databases: new Set(['all']),
        type: 'all',
        text: '',
        sort: 'relevance'
    };
    
    // Reset UI
    const dbFilters = document.getElementById('db-filters');
    if (dbFilters) {
        dbFilters.querySelectorAll('.filter-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.filter === 'all');
        });
    }
    
    const sortSelect = document.getElementById('sort-select');
    if (sortSelect) sortSelect.value = 'relevance';
    
    const typeSelect = document.getElementById('type-select');
    if (typeSelect) typeSelect.value = 'all';
    
    const resultFilter = document.getElementById('result-filter');
    if (resultFilter) resultFilter.value = '';
    
    applyFilters();
}

// Load saved state on page load
document.addEventListener('DOMContentLoaded', () => {
    loadSearchState();
    initFilterControls();
});

// Make function globally accessible
window.openReviewWindow = openReviewWindow;
window.resetFilters = resetFilters;
