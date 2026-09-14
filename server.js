const http = require('http');
const path = require('path');
const fsSync = require('fs');
const fs = require('fs/promises');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { URL } = require('url');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 8080);
const ROOT_DIR = __dirname;
const RUNTIME_ROOT = path.join(ROOT_DIR, '.runtime', 'workflow');
const PROJECTS_DIR = path.join(RUNTIME_ROOT, 'projects');
const STATE_FILE_NAME = 'project-state.json';
const STATE_FILE_BACKUP_NAME = 'project-state.backup.json';
const PYTHON_STAGE_SCRIPT = path.join(ROOT_DIR, 'backend', 'md_pipeline.py');
const DEFAULT_BUNDLED_BACKEND_EXECUTABLE = path.join(
    ROOT_DIR,
    'dist',
    'md-pipeline',
    process.platform === 'win32' ? 'md-pipeline.exe' : 'md-pipeline'
);
const BUNDLED_BACKEND_EXECUTABLE = resolveConfiguredBackendExecutable(
    process.env.MD_BACKEND_EXECUTABLE,
    DEFAULT_BUNDLED_BACKEND_EXECUTABLE
);
const PYTHON_COMMAND = process.env.MD_PYTHON_COMMAND || 'py';
const PYTHON_ARGS = (process.env.MD_PYTHON_ARGS || '-3').split(' ').filter(Boolean);
const projectMutationQueues = new Map();
const unreadableWorkflowProjectWarnings = new Map();
const STAGE_IDS = [
    'import',
    'protein-prep',
    'ligand-prep',
    'complex-build',
    'solvation',
    'ions',
    'minimization',
    'nvt',
    'npt',
    'production',
    'analysis'
];
const STAGE_HANDLERS = {
    import: runImportStage,
    'protein-prep': runProteinPrepStage,
    'ligand-prep': runLigandPrepStage,
    'complex-build': runComplexBuildStage,
    solvation: runSolvationStage,
    ions: runIonsStage,
    minimization: runMinimizationStage,
    nvt: runNvtStage,
    npt: runNptStage,
    production: runProductionStage
};
const CONTENT_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.csv': 'text/csv; charset=utf-8',
    '.xml': 'application/xml; charset=utf-8',
    '.ffxml': 'application/xml; charset=utf-8',
    '.offxml': 'application/xml; charset=utf-8',
    '.pdb': 'chemical/x-pdb; charset=utf-8',
    '.sdf': 'chemical/x-mdl-sdfile; charset=utf-8',
    '.mol': 'chemical/x-mdl-molfile; charset=utf-8',
    '.mol2': 'chemical/x-mol2; charset=utf-8',
    '.dcd': 'application/octet-stream',
    '.chk': 'application/octet-stream',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.txt': 'text/plain; charset=utf-8'
};
const POSE_IMPORT_EXTENSIONS = new Set(['.pdb', '.sdf', '.mol', '.mol2']);
const MAX_POSE_UPLOAD_BYTES = 12 * 1024 * 1024;
const EXCLUDED_REFERENCE_POSE_RESIDUE_NAMES = new Set([
    'HOH', 'WAT', 'SOL', 'TIP', 'TIP3', 'TIP4', 'TIP5',
    'NA', 'K', 'CL', 'CA', 'MG', 'ZN', 'MN', 'FE', 'CU', 'CO', 'NI', 'IOD', 'BR', 'CS', 'RB', 'SR', 'BA', 'CD', 'HG'
]);
const SEARCH_DATABASES = Object.freeze({
    alphafold: {
        name: 'AlphaFold',
        responseType: 'json',
        buildRequest(query) {
            return {
                url: `https://rest.uniprot.org/uniprotkb/search?query=${encodeURIComponent(query)}&format=json&size=5`,
                headers: {
                    'Accept': 'application/json'
                }
            };
        }
    },
    pdb: {
        name: 'Protein Data Bank (PDB)',
        responseType: 'json',
        buildRequest(query) {
            return {
                url: 'https://search.rcsb.org/rcsbsearch/v2/query',
                method: 'POST',
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(createPdbSearchBody(query))
            };
        }
    },
    kegg: {
        name: 'KEGG Database',
        responseType: 'text',
        buildRequest(query) {
            const isKeggId = /^([a-z]{2,4}[:\d]|[CDGRKM]\d{5}|map\d{5}|\d+\.\d+\.\d+)/i.test(query);
            return {
                url: isKeggId
                    ? `https://rest.kegg.jp/get/${encodeURIComponent(query)}`
                    : `https://rest.kegg.jp/find/compound/${encodeURIComponent(query)}`,
                headers: {
                    'Accept': 'text/plain'
                }
            };
        },
        allowEmpty404: true
    },
    pubchem: {
        name: 'PubChem Compounds',
        responseType: 'json',
        buildRequest(query) {
            const isNumeric = /^\d+$/.test(query);
            return {
                url: isNumeric
                    ? `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid/${query}/property/Title,MolecularFormula,MolecularWeight,CanonicalSMILES,InChIKey/JSON`
                    : `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/${encodeURIComponent(query)}/cids/JSON?name_type=word`,
                headers: {
                    'Accept': 'application/json'
                }
            };
        }
    },
    pubchem_substances: {
        name: 'PubChem Substances',
        responseType: 'json',
        buildRequest(query) {
            const isNumeric = /^\d+$/.test(query);
            return {
                url: isNumeric
                    ? `https://pubchem.ncbi.nlm.nih.gov/rest/pug/substance/sid/${query}/JSON`
                    : `https://pubchem.ncbi.nlm.nih.gov/rest/pug/substance/name/${encodeURIComponent(query)}/sids/JSON?name_type=word`,
                headers: {
                    'Accept': 'application/json'
                }
            };
        }
    },
    pubchem_literature: {
        name: 'PubChem Literature',
        responseType: 'json',
        buildRequest(query) {
            return {
                url: `https://pubchem.ncbi.nlm.nih.gov/sdq/sdqagent.cgi?infmt=json&outfmt=json&query={"select":"*","collection":"pubmed","where":{"ands":[{"*":"${encodeURIComponent(query)}"}]},"start":1,"limit":10}`,
                headers: {
                    'Accept': 'application/json'
                }
            };
        }
    },
    uniprot: {
        name: 'UniProt',
        responseType: 'json',
        buildRequest(query) {
            return {
                url: `https://rest.uniprot.org/uniprotkb/search?query=${encodeURIComponent(query)}&format=json&size=10&fields=accession,protein_name,gene_names,organism_name,length,cc_function,sequence,xref_pdb,xref_alphafolddb`,
                headers: {
                    'Accept': 'application/json'
                }
            };
        }
    },
    chembl: {
        name: 'ChEMBL',
        responseType: 'json',
        buildRequest(query) {
            const upperQuery = String(query || '').toUpperCase();
            const isChemblId = upperQuery.startsWith('CHEMBL');
            return {
                url: isChemblId
                    ? `https://www.ebi.ac.uk/chembl/api/data/molecule/${upperQuery}.json`
                    : `https://www.ebi.ac.uk/chembl/api/data/molecule/search.json?q=${encodeURIComponent(query)}`,
                headers: {
                    'Accept': 'application/json'
                }
            };
        }
    }
});

const server = http.createServer(async (request, response) => {
    try {
        const requestUrl = new URL(request.url, `http://${request.headers.host || `${HOST}:${PORT}`}`);

        if (request.method === 'OPTIONS') {
            sendEmpty(response, 204);
            return;
        }

        if (requestUrl.pathname.startsWith('/api/')) {
            await handleApiRequest(request, response, requestUrl);
            return;
        }

        await handleStaticRequest(response, requestUrl.pathname);
    } catch (error) {
        console.error('Server error:', error);
        sendJson(response, 500, { error: error.message || 'Unexpected server error' });
    }
});

ensureRuntimeDirectories()
    .then(() => {
        server.listen(PORT, HOST, () => {
            console.log(`Molecular analysis server running at http://${HOST}:${PORT}`);
            console.log(`Workflow runtime directory: ${RUNTIME_ROOT}`);
        });
    })
    .catch(error => {
        console.error('Unable to initialize runtime directories:', error);
        process.exitCode = 1;
    });

async function handleApiRequest(request, response, requestUrl) {
    const pathname = requestUrl.pathname;

    if (request.method === 'POST' && pathname === '/api/search') {
        const payload = await readJsonBody(request);
        try {
            const data = await executeDatabaseSearch(payload.dbKey, payload.query);
            sendJson(response, 200, { data });
        } catch (error) {
            const networkDetail = classifySearchFailure(error);
            if (networkDetail) {
                sendJson(response, 200, {
                    data: networkDetail.emptyShape,
                    unavailable: true,
                    reason: networkDetail.reason,
                    detail: networkDetail.detail
                });
                return;
            }
            throw error;
        }
        return;
    }

    if (request.method === 'POST' && pathname === '/api/search/pdb-details') {
        const payload = await readJsonBody(request);
        const data = await fetchPdbEntryDetails(payload.pdbIds);
        sendJson(response, 200, { data });
        return;
    }

    if (request.method === 'POST' && pathname === '/api/search/pubchem-properties') {
        const payload = await readJsonBody(request);
        const data = await fetchPubChemCompoundProperties(payload.cids);
        sendJson(response, 200, { data });
        return;
    }

    if (request.method === 'GET' && pathname === '/api/proxy') {
        await handleExternalProxy(request, response, requestUrl);
        return;
    }

    if (request.method === 'GET' && pathname === '/api/health') {
        const backendRunner = resolveBackendRunner();
        sendJson(response, 200, {
            status: 'ok',
            serverTime: new Date().toISOString(),
            runtimeRoot: toWorkspaceRelativePath(RUNTIME_ROOT),
            backendRunner: {
                mode: backendRunner.mode,
                command: toWorkspaceRelativePathOrLiteral(backendRunner.command)
            }
        });
        return;
    }

    if (request.method === 'POST' && pathname === '/api/workflow/pose-imports') {
        const payload = await readJsonBody(request);
        const uploadResult = await uploadWorkflowPoseImport(payload);
        sendJson(response, 201, uploadResult);
        return;
    }

    if (request.method === 'GET' && pathname === '/api/workflow/projects/latest') {
        const projectState = await loadLatestProjectState();
        if (!projectState) {
            sendJson(response, 404, { error: 'No workflow projects are available yet.' });
            return;
        }

        sendJson(response, 200, { project: serializeProjectState(projectState) });
        return;
    }

    if (request.method === 'GET' && pathname === '/api/workflow/projects') {
        const result = await listWorkflowProjectSummaries();
        sendJson(response, 200, result);
        return;
    }

    const projectMatch = pathname.match(/^\/api\/workflow\/projects\/([a-z0-9-]+)$/i);
    if (request.method === 'GET' && projectMatch) {
        const projectState = await loadProjectState(projectMatch[1]);
        if (!projectState) {
            sendJson(response, 404, { error: 'Project state not found' });
            return;
        }

        sendJson(response, 200, { project: serializeProjectState(projectState) });
        return;
    }

    const stageStartMatch = pathname.match(/^\/api\/workflow\/stages\/([a-z0-9-]+)\/start$/i);
    if (request.method === 'POST' && stageStartMatch) {
        const payload = await readJsonBody(request);
        const stageId = stageStartMatch[1];

        if (!STAGE_HANDLERS[stageId]) {
            sendJson(response, 501, { error: `Stage ${stageId} is not wired to the backend yet.` });
            return;
        }

        const startResult = await startStageJob(stageId, payload);
        sendJson(response, 202, startResult);
        return;
    }

    const stageResetMatch = pathname.match(/^\/api\/workflow\/stages\/([a-z0-9-]+)\/reset$/i);
    if (request.method === 'POST' && stageResetMatch) {
        const payload = await readJsonBody(request);
        const stageId = stageResetMatch[1];
        const projectId = sanitizeProjectId(payload.projectId);

        if (!projectId) {
            sendJson(response, 400, { error: 'projectId is required to reset a stage.' });
            return;
        }

        const projectState = await mutateProjectState(projectId, state => {
            const stageState = ensureStageState(state, stageId);
            if (stageState.status === 'running' || stageState.status === 'queued') {
                throw new Error('Cannot reset a stage while a job is still active.');
            }

            state.stageState[stageId] = createDefaultStageState(stageId);
        });

        sendJson(response, 200, { project: serializeProjectState(projectState) });
        return;
    }

    sendJson(response, 404, { error: 'API route not found' });
}

async function handleStaticRequest(response, pathname) {
    const relativePath = pathname === '/' ? '/index.html' : pathname;
    const resolvedPath = path.resolve(ROOT_DIR, `.${relativePath}`);

    if (!resolvedPath.startsWith(ROOT_DIR)) {
        sendJson(response, 403, { error: 'Forbidden path' });
        return;
    }

    try {
        const stats = await fs.stat(resolvedPath);
        const filePath = stats.isDirectory() ? path.join(resolvedPath, 'index.html') : resolvedPath;
        const fileBuffer = await fs.readFile(filePath);
        const extension = path.extname(filePath).toLowerCase();
        response.writeHead(200, { 'Content-Type': CONTENT_TYPES[extension] || 'application/octet-stream' });
        response.end(fileBuffer);
    } catch (error) {
        if (error.code === 'ENOENT') {
            sendJson(response, 404, { error: 'File not found' });
            return;
        }

        throw error;
    }
}

async function ensureRuntimeDirectories() {
    await fs.mkdir(PROJECTS_DIR, { recursive: true });
}

async function readJsonBody(request) {
    const chunks = [];

    for await (const chunk of request) {
        chunks.push(chunk);
    }

    if (!chunks.length) {
        return {};
    }

    const rawBody = Buffer.concat(chunks).toString('utf8').trim();
    if (!rawBody) {
        return {};
    }

    try {
        return JSON.parse(rawBody);
    } catch (error) {
        throw new Error('Invalid JSON body');
    }
}

function createPdbSearchBody(query) {
    return {
        query: {
            type: 'terminal',
            service: 'full_text',
            parameters: {
                value: query
            }
        },
        return_type: 'entry',
        request_options: {
            paginate: {
                start: 0,
                rows: 10
            },
            results_content_type: ['experimental'],
            sort: [
                {
                    sort_by: 'score',
                    direction: 'desc'
                }
            ]
        }
    };
}

const NETWORK_FAILURE_CODES = new Set([
    'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ECONNREFUSED',
    'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET'
]);

const EXTERNAL_PROXY_ALLOWED_HOSTS = new Set([
    'alphafold.ebi.ac.uk',
    'rest.uniprot.org',
    'www.uniprot.org',
    'files.rcsb.org',
    'data.rcsb.org',
    'search.rcsb.org',
    'www.ebi.ac.uk',
    'rest.kegg.jp',
    'www.kegg.jp',
    'pubchem.ncbi.nlm.nih.gov',
    'eutils.ncbi.nlm.nih.gov'
]);

const EXTERNAL_PROXY_FORWARD_HEADERS = new Set([
    'content-type',
    'content-disposition',
    'cache-control',
    'etag',
    'last-modified'
]);

const EXTERNAL_PROXY_TIMEOUT_MS = 30000;

async function handleExternalProxy(request, response, requestUrl) {
    const targetParam = requestUrl.searchParams.get('url');
    if (!targetParam) {
        sendJson(response, 400, { error: 'Missing url parameter' });
        return;
    }

    let target;
    try {
        target = new URL(targetParam);
    } catch (parseError) {
        sendJson(response, 400, { error: 'Invalid url parameter', detail: parseError.message });
        return;
    }

    if (target.protocol !== 'https:' && target.protocol !== 'http:') {
        sendJson(response, 400, { error: 'Only http(s) URLs may be proxied' });
        return;
    }

    if (!EXTERNAL_PROXY_ALLOWED_HOSTS.has(target.hostname)) {
        sendJson(response, 403, { error: `Host not allowed: ${target.hostname}` });
        return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), EXTERNAL_PROXY_TIMEOUT_MS);

    let upstream;
    try {
        upstream = await fetch(target, {
            method: 'GET',
            headers: {
                'Accept': request.headers['accept'] || '*/*',
                'User-Agent': 'MolecularAnalysisWorkspace/1.0 (+local-proxy)'
            },
            signal: controller.signal,
            redirect: 'follow'
        });
    } catch (fetchError) {
        clearTimeout(timer);
        const cause = fetchError && (fetchError.cause || fetchError);
        const code = (cause && cause.code) || fetchError.code;
        const reason = code && NETWORK_FAILURE_CODES.has(code) ? 'network-unavailable' : 'fetch-failed';
        sendJson(response, 502, {
            error: reason,
            detail: fetchError.message || String(fetchError),
            target: target.toString()
        });
        return;
    }
    clearTimeout(timer);

    const headers = {};
    upstream.headers.forEach((value, key) => {
        if (EXTERNAL_PROXY_FORWARD_HEADERS.has(key.toLowerCase())) {
            headers[key] = value;
        }
    });
    headers['Access-Control-Allow-Origin'] = '*';

    response.writeHead(upstream.status, headers);

    if (request.method === 'HEAD' || !upstream.body) {
        response.end();
        return;
    }

    try {
        const buffer = Buffer.from(await upstream.arrayBuffer());
        response.end(buffer);
    } catch (streamError) {
        if (!response.writableEnded) {
            response.end();
        }
        console.warn(`Proxy stream error for ${target.toString()}: ${streamError.message}`);
    }
}

function classifySearchFailure(error) {
    const cause = error && (error.cause || error);
    const code = (cause && cause.code) || (error && error.code);
    const responseTypeHint = error && error.responseTypeHint;
    const emptyShape = responseTypeHint === 'text' ? '' : {};

    if (code && NETWORK_FAILURE_CODES.has(code)) {
        return {
            reason: 'network-unavailable',
            detail: `${code}: ${cause && cause.message || error.message || 'no detail'}`,
            emptyShape
        };
    }

    if (error && error.name === 'TypeError' && /fetch failed/i.test(error.message || '')) {
        return {
            reason: 'network-unavailable',
            detail: cause && cause.message ? cause.message : error.message,
            emptyShape
        };
    }

    if (error && typeof error.upstreamStatus === 'number' && error.upstreamStatus >= 500) {
        return {
            reason: 'upstream-error',
            detail: `Upstream HTTP ${error.upstreamStatus}`,
            emptyShape
        };
    }

    return null;
}

async function executeDatabaseSearch(dbKey, query) {
    const normalizedDbKey = String(dbKey || '').trim();
    const normalizedQuery = String(query || '').trim();
    const database = SEARCH_DATABASES[normalizedDbKey];

    if (!database) {
        throw new Error(`Unsupported search database: ${normalizedDbKey}`);
    }

    if (!normalizedQuery) {
        throw new Error('query is required');
    }

    const requestConfig = database.buildRequest(normalizedQuery);
    let remoteResponse;
    try {
        remoteResponse = await fetch(requestConfig.url, {
            method: requestConfig.method || 'GET',
            headers: requestConfig.headers || {},
            body: requestConfig.body
        });
    } catch (fetchError) {
        fetchError.responseTypeHint = database.responseType;
        throw fetchError;
    }

    if (remoteResponse.status === 404) {
        // Upstreams like PubChem/KEGG return 404 when a query has no matches.
        // Treat as an empty result rather than surfacing a 500 to the UI.
        return database.responseType === 'text' ? '' : {};
    }

    if (!remoteResponse.ok) {
        const upstreamError = new Error(`Remote search failed for ${database.name} with HTTP ${remoteResponse.status}`);
        upstreamError.upstreamStatus = remoteResponse.status;
        upstreamError.responseTypeHint = database.responseType;
        throw upstreamError;
    }

    if (database.responseType === 'text') {
        return await remoteResponse.text();
    }

    return await remoteResponse.json();
}

async function fetchPdbEntryDetails(pdbIds) {
    const normalizedIds = Array.from(new Set(
        (Array.isArray(pdbIds) ? pdbIds : [])
            .map(value => String(value || '').trim().toUpperCase())
            .filter(Boolean)
    )).slice(0, 10);

    if (!normalizedIds.length) {
        return { data: { entries: [] } };
    }

    const remoteResponse = await fetch('https://data.rcsb.org/graphql', {
        method: 'POST',
        headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            query: `
                query {
                    entries(entry_ids: ${JSON.stringify(normalizedIds)}) {
                        rcsb_id
                        struct {
                            title
                        }
                        rcsb_entry_info {
                            resolution_combined
                            experimental_method
                            deposited_atom_count
                            polymer_entity_count
                        }
                        rcsb_accession_info {
                            deposit_date
                        }
                        polymer_entities {
                            rcsb_polymer_entity {
                                pdbx_description
                            }
                            rcsb_entity_source_organism {
                                scientific_name
                            }
                        }
                    }
                }
            `
        })
    });

    if (!remoteResponse.ok) {
        throw new Error(`Unable to load PDB details with HTTP ${remoteResponse.status}`);
    }

    return await remoteResponse.json();
}

async function fetchPubChemCompoundProperties(cids) {
    const normalizedCids = Array.from(new Set(
        (Array.isArray(cids) ? cids : [])
            .map(value => String(value || '').trim())
            .filter(value => /^\d+$/.test(value))
    )).slice(0, 10);

    if (!normalizedCids.length) {
        return { PropertyTable: { Properties: [] } };
    }

    const remoteResponse = await fetch(
        `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid/${normalizedCids.join(',')}/property/Title,MolecularFormula,MolecularWeight,CanonicalSMILES,InChIKey/JSON`,
        {
            headers: {
                'Accept': 'application/json'
            }
        }
    );

    if (!remoteResponse.ok) {
        throw new Error(`Unable to load PubChem compound properties with HTTP ${remoteResponse.status}`);
    }

    return await remoteResponse.json();
}

async function startStageJob(stageId, payload = {}) {
    const projectId = sanitizeProjectId(payload.projectId) || createProjectId(payload.projectName);
    const now = new Date().toISOString();
    const jobId = `job-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

    const projectState = await mutateProjectState(projectId, state => {
        mergeProjectPayload(state, payload, projectId);

        const stageState = ensureStageState(state, stageId);
        if (stageState.status === 'running' || stageState.status === 'queued') {
            throw new Error(`Stage ${stageId} already has an active job.`);
        }

        state.jobs[jobId] = {
            id: jobId,
            stageId,
            status: 'queued',
            createdAt: now,
            startedAt: '',
            finishedAt: '',
            error: '',
            checkpoint: null,
            artifactPaths: [],
            logEntries: []
        };

        stageState.status = 'queued';
        stageState.activeJobId = jobId;
        stageState.lastJobId = jobId;
        stageState.lastRunAt = now;
        stageState.updatedAt = now;
        stageState.error = '';
        appendStageLog(state, stageId, 'Stage accepted by local backend and queued for execution.', 'info', jobId);
    });

    setTimeout(() => {
        executeStageJob(projectId, stageId, jobId, payload).catch(error => {
            console.error(`Job ${jobId} failed unexpectedly:`, error);
        });
    }, 10);

    return {
        project: serializeProjectState(projectState),
        jobId,
        stageId
    };
}

async function uploadWorkflowPoseImport(payload = {}) {
    const originalFileName = typeof payload.fileName === 'string' ? payload.fileName.trim() : '';
    if (!originalFileName) {
        throw new Error('Pose upload requires a file name.');
    }

    const extension = path.extname(originalFileName).toLowerCase();
    if (!POSE_IMPORT_EXTENSIONS.has(extension)) {
        throw new Error('Pose uploads must use .pdb, .sdf, .mol, or .mol2 files.');
    }

    const contentBase64 = typeof payload.contentBase64 === 'string' ? payload.contentBase64.trim() : '';
    if (!contentBase64) {
        throw new Error('Pose upload requires file contents.');
    }

    const fileBuffer = Buffer.from(contentBase64, 'base64');
    if (!fileBuffer.length) {
        throw new Error('Pose upload is empty.');
    }
    if (fileBuffer.length > MAX_POSE_UPLOAD_BYTES) {
        throw new Error('Pose upload exceeds the 12 MB local upload limit.');
    }

    const projectId = sanitizeProjectId(payload.projectId) || createProjectId(payload.projectName);
    const importsDirectory = path.join(getProjectDirectory(projectId), 'imports');
    const sanitizedFileName = sanitizeUploadFileName(originalFileName);
    const storedFileName = `${Date.now()}-${sanitizedFileName}`;
    const storedFilePath = path.join(importsDirectory, storedFileName);
    const relativeFilePath = toWorkspaceRelativePath(storedFilePath);
    const currentComplexConfig = extractStageConfigSnapshot(payload.stageData || {})['complex-build'] || {};
    const residueScan = scanReferencePoseResidues(fileBuffer, extension);
    const nextReferenceResidueId = residueScan.options.some(option => option.value === currentComplexConfig.referenceResidueId)
        ? currentComplexConfig.referenceResidueId
        : '';

    await fs.mkdir(importsDirectory, { recursive: true });
    await fs.writeFile(storedFilePath, fileBuffer);

    const projectState = await mutateProjectState(projectId, state => {
        mergeProjectPayload(state, payload, projectId);
        state.workflowSnapshot.stageConfig['complex-build'] = {
            ...(state.workflowSnapshot.stageConfig['complex-build'] || {}),
            poseImportPath: relativeFilePath,
            referenceResidueId: nextReferenceResidueId,
            referenceResidueOptions: residueScan.options,
            referencePoseSourceType: residueScan.sourceType
        };
        appendStageLog(state, 'complex-build', `Imported pose file ${path.basename(originalFileName)} into the managed project workspace.`, 'info');
    });

    return {
        project: serializeProjectState(projectState),
        upload: {
            path: relativeFilePath,
            fileName: path.basename(originalFileName),
            storedFileName,
            sizeBytes: fileBuffer.length,
            extension,
            sourceType: residueScan.sourceType,
            referenceResidueId: nextReferenceResidueId,
            referenceResidueOptions: residueScan.options
        }
    };
}

async function executeStageJob(projectId, stageId, jobId, payload) {
    try {
        await mutateProjectState(projectId, state => {
            const stageState = ensureStageState(state, stageId);
            const job = state.jobs[jobId];
            const now = new Date().toISOString();

            stageState.status = 'running';
            stageState.updatedAt = now;
            job.status = 'running';
            job.startedAt = now;
            appendStageLog(state, stageId, 'Execution started.', 'info', jobId);
        });

        const projectState = await loadProjectState(projectId);
        const result = await STAGE_HANDLERS[stageId]({
            projectId,
            jobId,
            projectState,
            payload,
            log: (message, level = 'info') => appendProjectLog(projectId, stageId, jobId, message, level)
        });

        await mutateProjectState(projectId, state => {
            const stageState = ensureStageState(state, stageId);
            const job = state.jobs[jobId];
            const now = new Date().toISOString();

            stageState.status = 'completed';
            stageState.activeJobId = '';
            stageState.completedAt = now;
            stageState.updatedAt = now;
            stageState.checkpoint = result.checkpoint;
            stageState.artifactPaths = result.artifactPaths || [];
            stageState.error = '';

            job.status = 'completed';
            job.finishedAt = now;
            job.error = '';
            job.checkpoint = result.checkpoint;
            job.artifactPaths = result.artifactPaths || [];

            appendStageLog(state, stageId, result.summary || 'Stage completed successfully.', 'success', jobId);
        });
    } catch (error) {
        await mutateProjectState(projectId, state => {
            const stageState = ensureStageState(state, stageId);
            const job = state.jobs[jobId];
            const now = new Date().toISOString();

            stageState.status = 'failed';
            stageState.activeJobId = '';
            stageState.updatedAt = now;
            stageState.error = error.message;

            if (job) {
                job.status = 'failed';
                job.finishedAt = now;
                job.error = error.message;
            }

            appendStageLog(state, stageId, error.message, 'error', jobId);
        });
    }
}

async function runImportStage({ projectId, projectState, payload, log }) {
    const projectDir = getProjectDirectory(projectId);
    const stageDir = path.join(projectDir, 'stages', 'import');
    await fs.mkdir(stageDir, { recursive: true });

    await log('Preparing managed project workspace for imported assets.');
    await sleep(160);

    const manifest = buildProjectManifest(projectId, payload);
    const manifestPath = path.join(projectDir, 'project-manifest.json');
    const selectionPath = path.join(projectDir, 'selected-molecules.json');
    const environmentPath = path.join(projectDir, 'environment-profile.json');
    const workflowPath = path.join(projectDir, 'workflow-project.json');
    const checkpointPath = path.join(stageDir, 'import-checkpoint.json');

    await Promise.all([
        writeJson(manifestPath, manifest),
        writeJson(selectionPath, payload.selectedMolecules || []),
        writeJson(environmentPath, payload.environmentProfile || {}),
        writeJson(workflowPath, {
            projectId,
            projectName: payload.projectName || projectState.projectName,
            workflowType: payload.workflowType || projectState.workflowType,
            engine: payload.engine || projectState.engine,
            generatedAt: new Date().toISOString(),
            stageConfig: extractStageConfigSnapshot(payload.stageData || {})
        })
    ]);

    await log('Manifest, selection bundle, and environment snapshot written to disk.');
    await sleep(160);

    const checkpoint = {
        label: 'Project manifest ready',
        summary: `${(payload.selectedMolecules || []).length} selected record(s) captured for ${payload.workflowType || projectState.workflowType}.`,
        generatedAt: new Date().toISOString(),
        manifestPath: toWorkspaceRelativePath(manifestPath),
        selectionPath: toWorkspaceRelativePath(selectionPath),
        environmentPath: toWorkspaceRelativePath(environmentPath),
        workflowPath: toWorkspaceRelativePath(workflowPath),
        selectionSummary: buildSelectionSummary(payload.selectedMolecules || []),
        environmentSummary: {
            ph: Number(payload.environmentProfile?.ph ?? 7.4),
            temperatureC: Number(payload.environmentProfile?.temperatureC ?? 25),
            ionicStrengthmM: Number(payload.environmentProfile?.ionicStrengthmM ?? 150),
            solvent: payload.environmentProfile?.solvent || 'aqueous'
        }
    };

    await writeJson(checkpointPath, checkpoint);
    await log('Import checkpoint saved for downstream preparation stages.');

    return {
        summary: 'Import artifacts and checkpoint are ready.',
        checkpoint,
        artifactPaths: [
            toWorkspaceRelativePath(manifestPath),
            toWorkspaceRelativePath(selectionPath),
            toWorkspaceRelativePath(environmentPath),
            toWorkspaceRelativePath(workflowPath),
            toWorkspaceRelativePath(checkpointPath)
        ]
    };
}

async function runProteinPrepStage(context) {
    const workflowType = context.payload.workflowType || context.projectState.workflowType;
    if (workflowType !== 'reactive-md-test') {
        validateStageSelection(context.payload, context.projectState, 'protein-prep', item => isStructureItem(item) || isProteinItem(item), 'Protein preparation requires at least one protein or structure selection.');
    }
    requireCompletedStage(context.projectState, 'import', 'Run Import & Project Setup before Protein Preparation.');
    return runPythonWorkflowStage('protein-prep', context);
}

async function runLigandPrepStage(context) {
    validateStageSelection(context.payload, context.projectState, 'ligand-prep', isCompoundItem, 'Ligand preparation requires at least one selected PubChem or ChEMBL compound.');
    requireCompletedStage(context.projectState, 'import', 'Run Import & Project Setup before Ligand Preparation.');
    return runPythonWorkflowStage('ligand-prep', context);
}

async function runComplexBuildStage(context) {
    requireCompletedStage(context.projectState, 'protein-prep', 'Run Protein Preparation before Complex Assembly.');
    if ((context.payload.workflowType || context.projectState.workflowType) === 'protein-ligand-water') {
        requireCompletedStage(context.projectState, 'ligand-prep', 'Run Ligand Preparation before Complex Assembly for protein-ligand workflows.');
    }
    return runPythonWorkflowStage('complex-build', context);
}

async function runSolvationStage(context) {
    requireCompletedStage(context.projectState, 'protein-prep', 'Run Protein Preparation before Solvation.');
    if ((context.payload.workflowType || context.projectState.workflowType) === 'protein-ligand-water') {
        requireCompletedStage(context.projectState, 'complex-build', 'Run Complex Assembly before Solvation for protein-ligand workflows.');
    }
    return runPythonWorkflowStage('solvation', context);
}

async function runIonsStage(context) {
    requireCompletedStage(context.projectState, 'solvation', 'Run Solvation before Neutralization & Ions.');
    return runPythonWorkflowStage('ions', context);
}

async function runMinimizationStage(context) {
    const workflowType = context.payload.workflowType || context.projectState.workflowType;
    if (workflowType === 'reactive-md-test') {
        requireCompletedStage(context.projectState, 'protein-prep', 'Run Protein Prep (H\u2083 topology) before Minimization.');
    } else {
        requireCompletedStage(context.projectState, 'ions', 'Run Neutralization & Ions before Minimization.');
    }
    return runPythonWorkflowStage('minimization', context);
}

async function runNvtStage(context) {
    requireCompletedStage(context.projectState, 'minimization', 'Run Energy Minimization before NVT equilibration.');
    return runPythonWorkflowStage('nvt', context);
}

async function runNptStage(context) {
    requireCompletedStage(context.projectState, 'nvt', 'Run NVT equilibration before NPT equilibration.');
    return runPythonWorkflowStage('npt', context);
}

async function runProductionStage(context) {
    requireCompletedStage(context.projectState, 'npt', 'Run NPT equilibration before Production MD.');
    return runPythonWorkflowStage('production', context);
}

async function appendProjectLog(projectId, stageId, jobId, message, level) {
    await mutateProjectState(projectId, state => {
        appendStageLog(state, stageId, message, level, jobId);
    });
}

function validateStageSelection(payload, projectState, stageId, predicate, errorMessage) {
    const sourceItems = Array.isArray(payload.selectedMolecules) ? payload.selectedMolecules : projectState.selectedMolecules;
    if (!sourceItems.some(predicate)) {
        throw new Error(errorMessage);
    }
}

function requireCompletedStage(projectState, stageId, errorMessage) {
    if (projectState.stageState?.[stageId]?.status !== 'completed') {
        throw new Error(errorMessage);
    }
}

async function runPythonWorkflowStage(stageId, { projectId, jobId, projectState, payload, log }) {
    const projectDir = getProjectDirectory(projectId);
    const stageDir = path.join(projectDir, 'stages', stageId);
    const jobDir = path.join(stageDir, 'jobs', jobId);
    const payloadPath = path.join(jobDir, 'payload.json');
    const resultPath = path.join(jobDir, 'result.json');

    await fs.mkdir(jobDir, { recursive: true });
    await writeJson(payloadPath, {
        rootDir: ROOT_DIR,
        projectDir,
        projectId,
        jobId,
        stageId,
        stageDir,
        jobDir,
        projectName: payload.projectName || projectState.projectName,
        workflowType: payload.workflowType || projectState.workflowType,
        engine: payload.engine || projectState.engine,
        selectedMolecules: Array.isArray(payload.selectedMolecules) ? payload.selectedMolecules : projectState.selectedMolecules,
        environmentProfile: payload.environmentProfile || projectState.environmentProfile || {},
        stageData: payload.stageData || projectState.workflowSnapshot?.stageConfig || {},
        stageCheckpoints: Object.fromEntries(
            STAGE_IDS.map(id => [id, projectState.stageState?.[id]?.checkpoint || null])
        )
    });

    const backendRunner = resolveBackendRunner(stageId, payloadPath, resultPath);
    await log(`Launching ${backendRunner.displayName} for ${stageId} with ${path.basename(backendRunner.command)}.`);

    const outputQueue = [];
    const childProcess = spawn(backendRunner.command, backendRunner.args, {
        cwd: ROOT_DIR,
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
    });

    childProcess.stdout.on('data', data => {
        outputQueue.push(...String(data).split(/\r?\n/).filter(Boolean).map(line => ({ line, level: parsePythonLogLevel(line) })));
    });
    childProcess.stderr.on('data', data => {
        outputQueue.push(...String(data).split(/\r?\n/).filter(Boolean).map(line => ({ line, level: 'error' })));
    });

    const intervalId = setInterval(() => {
        while (outputQueue.length > 0) {
            const nextEntry = outputQueue.shift();
            log(stripPythonLogLevel(nextEntry.line), nextEntry.level).catch(error => {
                console.error('Unable to append stage log:', error);
            });
        }
    }, 50);

    const exitCode = await new Promise((resolve, reject) => {
        childProcess.on('error', reject);
        childProcess.on('close', code => resolve(code ?? 1));
    }).finally(() => {
        clearInterval(intervalId);
    });

    while (outputQueue.length > 0) {
        const nextEntry = outputQueue.shift();
        await log(stripPythonLogLevel(nextEntry.line), nextEntry.level);
    }

    if (exitCode !== 0) {
        throw new Error(`${backendRunner.displayName} failed for ${stageId}. Check the stage logs for details.`);
    }

    const rawResult = await fs.readFile(resultPath, 'utf8');
    return JSON.parse(rawResult);
}

function parsePythonLogLevel(line) {
    const match = String(line).match(/^(INFO|WARN|ERROR)\|/i);
    if (!match) {
        return 'info';
    }
    const normalized = match[1].toLowerCase();
    return normalized === 'warn' ? 'info' : normalized;
}

function stripPythonLogLevel(line) {
    return String(line).replace(/^(INFO|WARN|ERROR)\|/i, '').trim();
}

function resolveConfiguredBackendExecutable(configuredPath, fallbackPath) {
    const rawPath = String(configuredPath || '').trim();
    if (rawPath) {
        return path.isAbsolute(rawPath) ? rawPath : path.resolve(ROOT_DIR, rawPath);
    }

    return fallbackPath;
}

function resolveBackendRunner(stageId, payloadPath, resultPath) {
    if (BUNDLED_BACKEND_EXECUTABLE && fsSync.existsSync(BUNDLED_BACKEND_EXECUTABLE)) {
        return {
            mode: 'bundled-executable',
            displayName: 'bundled backend runtime',
            command: BUNDLED_BACKEND_EXECUTABLE,
            args: buildBundledBackendArgs(stageId, payloadPath, resultPath)
        };
    }

    return {
        mode: 'python-script',
        displayName: 'Python backend',
        command: PYTHON_COMMAND,
        args: buildPythonBackendArgs(stageId, payloadPath, resultPath)
    };
}

function buildBundledBackendArgs(stageId, payloadPath, resultPath) {
    return [
        '--stage',
        stageId,
        '--payload',
        payloadPath,
        '--result',
        resultPath
    ].filter(Boolean);
}

function buildPythonBackendArgs(stageId, payloadPath, resultPath) {
    return [
        ...PYTHON_ARGS,
        PYTHON_STAGE_SCRIPT,
        '--stage',
        stageId,
        '--payload',
        payloadPath,
        '--result',
        resultPath
    ].filter(Boolean);
}

function toWorkspaceRelativePathOrLiteral(filePath) {
    const normalizedPath = String(filePath || '').trim();
    if (!normalizedPath) {
        return normalizedPath;
    }

    if (!path.isAbsolute(normalizedPath)) {
        return normalizedPath;
    }

    if (normalizedPath.startsWith(ROOT_DIR)) {
        return toWorkspaceRelativePath(normalizedPath);
    }

    return normalizedPath;
}

function buildProjectManifest(projectId, payload) {
    return {
        projectId,
        generatedAt: new Date().toISOString(),
        projectName: payload.projectName || 'Molecular Project',
        workflowType: payload.workflowType || 'protein-water',
        engine: payload.engine || 'openmm',
        selectionSummary: buildSelectionSummary(payload.selectedMolecules || []),
        environmentProfile: payload.environmentProfile || {},
        stageConfig: extractStageConfigSnapshot(payload.stageData || {}),
        selectedMolecules: payload.selectedMolecules || []
    };
}

function extractStageConfigSnapshot(stageData) {
    return Object.fromEntries(
        Object.entries(stageData).map(([stageId, stageState]) => {
            const stageConfig = stageState && typeof stageState === 'object' && Object.prototype.hasOwnProperty.call(stageState, 'config')
                ? stageState.config || {}
                : stageState || {};
            return [stageId, stageConfig];
        })
    );
}

async function mutateProjectState(projectId, mutator) {
    const sanitizedProjectId = sanitizeProjectId(projectId);
    const previousMutation = projectMutationQueues.get(sanitizedProjectId) || Promise.resolve();
    const currentMutation = previousMutation
        .catch(() => undefined)
        .then(async () => {
            const loadedState = await loadProjectState(sanitizedProjectId);
            const projectState = loadedState || createProjectState(sanitizedProjectId, {});
            mutator(projectState);
            projectState.updatedAt = new Date().toISOString();
            await saveProjectState(projectState);
            return projectState;
        });

    projectMutationQueues.set(sanitizedProjectId, currentMutation);

    try {
        return await currentMutation;
    } finally {
        if (projectMutationQueues.get(sanitizedProjectId) === currentMutation) {
            projectMutationQueues.delete(sanitizedProjectId);
        }
    }
}

async function loadProjectState(projectId) {
    const sanitizedProjectId = sanitizeProjectId(projectId);
    if (!sanitizedProjectId) {
        return null;
    }

    const projectDirectory = getProjectDirectory(sanitizedProjectId);
    const stateFilePath = path.join(projectDirectory, STATE_FILE_NAME);
    const backupFilePath = path.join(projectDirectory, STATE_FILE_BACKUP_NAME);
    try {
        const projectState = normalizeProjectState(await readJsonFile(stateFilePath), sanitizedProjectId);
        unreadableWorkflowProjectWarnings.delete(sanitizedProjectId);
        return projectState;
    } catch (error) {
        if (error.code === 'ENOENT') {
            return null;
        }

        if (isRecoverableProjectStateLoadError(error)) {
            try {
                const recoveredState = await readJsonFile(backupFilePath);
                await writeJson(stateFilePath, recoveredState, { backupFilePath });
                console.warn(`Recovered ${sanitizedProjectId} project state from backup after a partial or invalid JSON read.`);
                unreadableWorkflowProjectWarnings.delete(sanitizedProjectId);
                return normalizeProjectState(recoveredState, sanitizedProjectId);
            } catch (backupError) {
                void backupError;
            }

            // Backup recovery failed too. Quarantine the unreadable state file so that
            // subsequent server starts do not keep tripping over the same corrupt JSON.
            try {
                const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                const quarantinePath = path.join(
                    projectDirectory,
                    `${STATE_FILE_NAME}.corrupt-${timestamp}`
                );
                await fs.rename(stateFilePath, quarantinePath);
                console.warn(
                    `Quarantined unreadable workflow project state for ${sanitizedProjectId} -> ${path.basename(quarantinePath)}.`
                );
                unreadableWorkflowProjectWarnings.delete(sanitizedProjectId);
                return null;
            } catch (quarantineError) {
                void quarantineError;
            }
        }

        throw error;
    }
}

async function saveProjectState(projectState) {
    const projectDirectory = getProjectDirectory(projectState.projectId);
    await fs.mkdir(projectDirectory, { recursive: true });
    const stateFilePath = path.join(projectDirectory, STATE_FILE_NAME);
    const backupFilePath = path.join(projectDirectory, STATE_FILE_BACKUP_NAME);
    await writeJson(stateFilePath, projectState, { backupFilePath });
}

async function loadLatestProjectState() {
    const result = await listWorkflowProjectSummaries({ includeStates: true });
    return result.projects[0]?.projectState || null;
}

async function listWorkflowProjectSummaries(options = {}) {
    const includeStates = Boolean(options.includeStates);
    let projectEntries = [];

    try {
        projectEntries = await fs.readdir(PROJECTS_DIR, { withFileTypes: true });
    } catch (error) {
        if (error.code === 'ENOENT') {
            return { projects: [], skippedCount: 0 };
        }
        throw error;
    }

    const projects = [];
    let skippedCount = 0;

    for (const entry of projectEntries) {
        if (!entry.isDirectory()) {
            continue;
        }

        try {
            const projectState = await loadProjectState(entry.name);
            if (projectState) {
                projects.push(serializeWorkflowProjectSummary(projectState, includeStates));
            }
        } catch (error) {
            skippedCount += 1;
            warnUnreadableWorkflowProject(entry.name, error);
        }
    }

    projects.sort((left, right) => {
        const leftTime = Date.parse(left.updatedAt || left.createdAt || 0) || 0;
        const rightTime = Date.parse(right.updatedAt || right.createdAt || 0) || 0;
        return rightTime - leftTime;
    });

    return { projects, skippedCount };
}

function createProjectState(projectId, payload = {}) {
    const now = new Date().toISOString();
    const projectState = {
        projectId,
        projectName: payload.projectName || 'Molecular Project',
        workflowType: payload.workflowType || 'protein-water',
        engine: payload.engine || 'openmm',
        createdAt: now,
        updatedAt: now,
        selectedMolecules: Array.isArray(payload.selectedMolecules) ? payload.selectedMolecules : [],
        environmentProfile: payload.environmentProfile || {},
        workflowSnapshot: {
            activeStageId: payload.activeStageId || 'import',
            stageConfig: extractStageConfigSnapshot(payload.stageData || {})
        },
        stageState: {},
        jobs: {}
    };

    STAGE_IDS.forEach(stageId => {
        projectState.stageState[stageId] = createDefaultStageState(stageId);
    });

    return projectState;
}

function normalizeProjectState(projectState, fallbackProjectId) {
    const state = createProjectState(fallbackProjectId || projectState.projectId, projectState);
    state.projectId = sanitizeProjectId(projectState.projectId) || sanitizeProjectId(fallbackProjectId) || state.projectId;
    state.projectName = projectState.projectName || state.projectName;
    state.workflowType = projectState.workflowType || state.workflowType;
    state.engine = projectState.engine || state.engine;
    state.createdAt = projectState.createdAt || state.createdAt;
    state.updatedAt = projectState.updatedAt || state.updatedAt;
    state.selectedMolecules = Array.isArray(projectState.selectedMolecules) ? projectState.selectedMolecules : [];
    state.environmentProfile = projectState.environmentProfile || {};
    state.workflowSnapshot = {
        activeStageId: projectState.workflowSnapshot?.activeStageId || state.workflowSnapshot.activeStageId,
        stageConfig: extractStageConfigSnapshot(projectState.workflowSnapshot?.stageConfig || {})
    };
    state.jobs = projectState.jobs || {};

    STAGE_IDS.forEach(stageId => {
        state.stageState[stageId] = normalizeStageState(stageId, projectState.stageState?.[stageId]);
    });

    return state;
}

function normalizeStageState(stageId, stageState = {}) {
    const normalized = createDefaultStageState(stageId);
    normalized.status = stageState.status || normalized.status;
    normalized.activeJobId = stageState.activeJobId || '';
    normalized.lastJobId = stageState.lastJobId || '';
    normalized.lastRunAt = stageState.lastRunAt || '';
    normalized.completedAt = stageState.completedAt || '';
    normalized.updatedAt = stageState.updatedAt || '';
    normalized.error = stageState.error || '';
    normalized.checkpoint = stageState.checkpoint || null;
    normalized.artifactPaths = Array.isArray(stageState.artifactPaths) ? stageState.artifactPaths : [];
    normalized.logEntries = Array.isArray(stageState.logEntries) ? stageState.logEntries.slice(-40) : [];
    return normalized;
}

function mergeProjectPayload(projectState, payload, projectId) {
    const merged = projectState;
    merged.projectId = projectId;
    merged.projectName = payload.projectName || merged.projectName;
    merged.workflowType = payload.workflowType || merged.workflowType;
    merged.engine = payload.engine || merged.engine;
    merged.selectedMolecules = Array.isArray(payload.selectedMolecules) ? payload.selectedMolecules : merged.selectedMolecules;
    merged.environmentProfile = payload.environmentProfile || merged.environmentProfile;
    merged.workflowSnapshot = {
        activeStageId: payload.activeStageId || merged.workflowSnapshot.activeStageId,
        stageConfig: {
            ...merged.workflowSnapshot.stageConfig,
            ...extractStageConfigSnapshot(payload.stageData || {})
        }
    };
}

function ensureStageState(projectState, stageId) {
    if (!projectState.stageState[stageId]) {
        projectState.stageState[stageId] = createDefaultStageState(stageId);
    }
    return projectState.stageState[stageId];
}

function createDefaultStageState(stageId) {
    return {
        supported: Boolean(STAGE_HANDLERS[stageId]),
        status: STAGE_HANDLERS[stageId] ? 'idle' : 'not-wired',
        activeJobId: '',
        lastJobId: '',
        lastRunAt: '',
        completedAt: '',
        updatedAt: '',
        error: '',
        checkpoint: null,
        artifactPaths: [],
        logEntries: []
    };
}

function appendStageLog(projectState, stageId, message, level = 'info', jobId = '') {
    const timestamp = new Date().toISOString();
    const entry = { timestamp, level, message };
    const stageState = ensureStageState(projectState, stageId);

    stageState.logEntries = [...stageState.logEntries, entry].slice(-40);
    stageState.updatedAt = timestamp;

    if (jobId) {
        const job = projectState.jobs[jobId] || {
            id: jobId,
            stageId,
            status: 'running',
            createdAt: timestamp,
            startedAt: '',
            finishedAt: '',
            error: '',
            checkpoint: null,
            artifactPaths: [],
            logEntries: []
        };
        job.logEntries = [...job.logEntries, entry].slice(-80);
        projectState.jobs[jobId] = job;
    }
}

function serializeProjectState(projectState) {
    return {
        projectId: projectState.projectId,
        projectName: projectState.projectName,
        workflowType: projectState.workflowType,
        engine: projectState.engine,
        createdAt: projectState.createdAt,
        updatedAt: projectState.updatedAt,
        selectedMolecules: projectState.selectedMolecules,
        environmentProfile: projectState.environmentProfile,
        workflowSnapshot: projectState.workflowSnapshot,
        stageState: projectState.stageState
    };
}

function serializeWorkflowProjectSummary(projectState, includeState = false) {
    const selectionSummary = buildSelectionSummary(projectState.selectedMolecules || []);
    const completeStageCount = STAGE_IDS.filter(stageId => projectState.stageState?.[stageId]?.status === 'completed').length;
    const summary = {
        projectId: projectState.projectId,
        projectName: projectState.projectName,
        workflowType: projectState.workflowType,
        engine: projectState.engine,
        createdAt: projectState.createdAt,
        updatedAt: projectState.updatedAt,
        activeStageId: projectState.workflowSnapshot?.activeStageId || 'import',
        selectedCount: selectionSummary.total,
        structureCount: selectionSummary.structure,
        compoundCount: selectionSummary.compound,
        completeStageCount
    };

    if (includeState) {
        summary.projectState = projectState;
    }

    return summary;
}

function buildSelectionSummary(items) {
    const summary = {
        total: items.length,
        pdb: 0,
        alphafold: 0,
        protein: 0,
        compound: 0,
        structure: 0,
        kegg: 0
    };

    items.forEach(item => {
        if (isPdbItem(item)) {
            summary.pdb++;
            summary.structure++;
        } else if (isAlphaFoldItem(item)) {
            summary.alphafold++;
            summary.structure++;
            summary.protein++;
        } else if (isProteinItem(item)) {
            summary.protein++;
        } else if (isCompoundItem(item)) {
            summary.compound++;
        } else if (isKeggItem(item)) {
            summary.kegg++;
        }
    });

    return summary;
}

function isPdbItem(item) {
    const database = String(item?.database || '').toLowerCase();
    return database.includes('pdb') && !database.includes('alphafold');
}

function isAlphaFoldItem(item) {
    return String(item?.database || '').toLowerCase().includes('alphafold');
}

function isProteinItem(item) {
    const database = String(item?.database || '').toLowerCase();
    return isAlphaFoldItem(item) || database.includes('uniprot');
}

function isStructureItem(item) {
    return isPdbItem(item) || isAlphaFoldItem(item);
}

function isCompoundItem(item) {
    const database = String(item?.database || '').toLowerCase();
    return database.includes('pubchem') || database.includes('chembl');
}

function isKeggItem(item) {
    return String(item?.database || '').toLowerCase().includes('kegg');
}

function sanitizeProjectId(value) {
    if (typeof value !== 'string') {
        return '';
    }
    const sanitized = value.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
    return sanitized;
}

function createProjectId(projectName) {
    const base = slugify(projectName || 'molecular-project');
    return `${base}-${crypto.randomBytes(3).toString('hex')}`;
}

function slugify(value) {
    return String(value || 'molecular-project')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48) || 'molecular-project';
}

function sanitizeUploadFileName(fileName) {
    const extension = path.extname(String(fileName || '')).toLowerCase();
    const baseName = path.basename(String(fileName || ''), extension);
    return `${slugify(baseName || 'reference-pose') || 'reference-pose'}${extension}`;
}

function scanReferencePoseResidues(fileBuffer, extension) {
    if (extension !== '.pdb') {
        return {
            sourceType: 'ligand-pose-file',
            options: []
        };
    }

    const pdbText = fileBuffer.toString('utf8');
    const pdbLines = pdbText.split(/\r?\n/);
    const hasPolymerRecords = pdbLines.some(line => line.startsWith('ATOM  '));
    const residueGroups = new Map();

    pdbLines.forEach(line => {
        if (!line.startsWith('HETATM')) {
            return;
        }

        const residueName = line.slice(17, 20).trim().toUpperCase() || 'UNK';
        if (EXCLUDED_REFERENCE_POSE_RESIDUE_NAMES.has(residueName)) {
            return;
        }

        const chainId = line.slice(21, 22).trim();
        const residueNumber = line.slice(22, 26).trim();
        const insertionCode = line.slice(26, 27).trim();
        const residueKey = [residueName, chainId, residueNumber, insertionCode].join('|');
        const residueGroup = residueGroups.get(residueKey) || {
            residueName,
            chainId,
            residueNumber,
            insertionCode,
            atomCount: 0,
            heavyAtomCount: 0
        };

        residueGroup.atomCount += 1;
        const elementSymbol = (line.slice(76, 78).trim() || line.slice(12, 16).trim().slice(0, 1)).toUpperCase();
        if (elementSymbol !== 'H') {
            residueGroup.heavyAtomCount += 1;
        }
        residueGroups.set(residueKey, residueGroup);
    });

    const options = Array.from(residueGroups.values())
        .filter(group => group.heavyAtomCount >= 3)
        .map(group => ({
            value: formatReferencePoseResidueId(group),
            label: `${formatReferencePoseResidueId(group)} · ${group.heavyAtomCount} heavy atoms`,
            residueName: group.residueName,
            heavyAtomCount: group.heavyAtomCount,
            atomCount: group.atomCount
        }));

    return {
        sourceType: hasPolymerRecords ? 'reference-complex-pdb' : 'ligand-only-pdb',
        options
    };
}

function formatReferencePoseResidueId(group) {
    const chainPrefix = group.chainId ? `${group.chainId}:` : '';
    const insertionSuffix = group.insertionCode || '';
    return `${group.residueName} ${chainPrefix}${group.residueNumber}${insertionSuffix}`.trim();
}

function getProjectDirectory(projectId) {
    return path.join(PROJECTS_DIR, sanitizeProjectId(projectId));
}

async function readJsonFile(filePath) {
    const rawValue = await fs.readFile(filePath, 'utf8');
    if (!rawValue.trim()) {
        const error = new Error('JSON file was empty.');
        error.code = 'EJSONEMPTY';
        throw error;
    }

    return JSON.parse(rawValue);
}

function isRecoverableProjectStateLoadError(error) {
    return error?.code === 'EJSONEMPTY' || error instanceof SyntaxError;
}

async function writeJson(filePath, value, options = {}) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const serializedValue = `${JSON.stringify(value, null, 2)}\n`;
    const tempFilePath = `${filePath}.${process.pid}.${Date.now()}.tmp`;

    await fs.writeFile(tempFilePath, serializedValue, 'utf8');
    await fs.rename(tempFilePath, filePath);

    if (options.backupFilePath) {
        await fs.writeFile(options.backupFilePath, serializedValue, 'utf8');
    }
}

function toWorkspaceRelativePath(filePath) {
    return path.relative(ROOT_DIR, filePath).split(path.sep).join('/');
}

function sendJson(response, statusCode, payload) {
    response.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
    });
    response.end(JSON.stringify(payload));
}

function sendEmpty(response, statusCode) {
    response.writeHead(statusCode, {
        'Cache-Control': 'no-store'
    });
    response.end();
}

function sleep(durationMs) {
    return new Promise(resolve => setTimeout(resolve, durationMs));
}

function warnUnreadableWorkflowProject(projectId, error) {
    const warningKey = sanitizeProjectId(projectId) || String(projectId || 'unknown-project');
    const warningMessage = String(error?.message || 'Unknown error while loading project state.');
    if (unreadableWorkflowProjectWarnings.get(warningKey) === warningMessage) {
        return;
    }

    unreadableWorkflowProjectWarnings.set(warningKey, warningMessage);
    console.warn(`Skipping unreadable workflow project ${warningKey}: ${warningMessage}`);
}