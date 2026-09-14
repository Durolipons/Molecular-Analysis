# Setup And Run

This project is a Windows-first browser application with a local Node.js server and a Python scientific backend.

## Prerequisites

For source development and local validation:

- Windows with PowerShell.
- Node.js and npm installed.
- Python 3.14 available as `py -3`.
- Internet access for the search APIs used by AlphaFold, PDB, UniProt, PubChem, ChEMBL, and KEGG.

For packaged desktop runtime usage:

- Windows with the packaged application installed.
- Internet access for the search APIs used by AlphaFold, PDB, UniProt, PubChem, ChEMBL, and KEGG.

The functional Windows desktop build can bundle the scientific backend as `dist/md-pipeline/md-pipeline.exe`, so installed desktop users do not need a separate Python environment when that bundled runtime is present.

## 1. Install Node.js Dependencies

From the repository root:

```powershell
npm install
```

## 2. Install Python MD Dependencies

From the repository root:

```powershell
py -3 -m pip install -r requirements-md.txt
```

The Python dependency manifest currently includes:

- OpenMM
- PDBFixer
- OpenMMForceFields
- RDKit
- OpenFF Toolkit and supporting OpenFF packages from source
- `xmltodict`
- `python-constraint`

## 3. Start The Integrated Application Server

Default port:

```powershell
npm start
```

Optional alternate port:

```powershell
$env:PORT=8083; npm start
```

The server hosts both the static UI and the workflow API.

## 4. Open The Unified Workspace

If you are using the default port:

- Unified workspace: `http://127.0.0.1:8080/`
- Legacy review URL: `http://127.0.0.1:8080/review.html` redirects into the unified workspace

If you started with `PORT=8083`, replace `8080` with `8083` in both URLs.

## 5. Verify Backend Health

Use the health endpoint to confirm the backend is responding:

```powershell
Invoke-RestMethod -Uri 'http://127.0.0.1:8080/api/health' -Method Get
```

Example alternate-port check:

```powershell
Invoke-RestMethod -Uri 'http://127.0.0.1:8083/api/health' -Method Get
```

## 6. Understand The Unified Shell

- `index.html`: single SPA shell for search, selection review, saved-project recovery, environment settings, and workflow execution.
- `review.html`: compatibility redirect into the Review view inside `index.html`.

Navigation now happens inside the same shell:

- `Search` view: cross-database search and result curation
- `Review` view: selected-item summary, workflow orchestration, environment profile, and saved-project recovery

## 7. Runtime Data Location

When the backend runs stages, it writes managed state under:

```text
.runtime/workflow/projects/<project-id>/
```

Important files and folders:

- `project-state.json`: persisted workflow state and job history
- `imports/`: managed uploaded pose/reference files
- `stages/<stage-id>/`: artifacts, logs, reports, and checkpoints for each stage

## Useful Validation Commands

```powershell
node --check .\server.js
node --check .\js\spa-shell.js
node --check .\js\review.js
py -3 -m py_compile .\backend\md_pipeline.py
```

## Windows Packaging

Build the frozen backend runtime:

```powershell
npm run build:backend
```

Package the Electron desktop runtime without building a final installer:

```powershell
npm run pack:desktop
```

Build Windows installer and portable executable artifacts:

```powershell
npm run dist:win
npm run dist:win:portable
```

Build the functional Windows artifacts, including the frozen backend runtime:

```powershell
npm run dist:win:functional
npm run dist:win:portable:functional
```

Functional packaging currently assumes:

- the desktop app bundles the unified shell, Node.js server, static frontend assets, and `dist/md-pipeline/md-pipeline.exe`
- development builds still need the Python scientific stack if the frozen backend has not been built yet
- `asar` remains disabled so the packaged app can execute the bundled backend from unpacked files

After a successful functional package build, the unpacked desktop payload should contain:

```text
dist/desktop/win-unpacked/resources/app/dist/md-pipeline/md-pipeline.exe
```

When that bundled runtime is available, `GET /api/health` reports:

- `backendRunner.mode: bundled-executable`
- `backendRunner.command: dist/md-pipeline/md-pipeline.exe`

## Recommended First Working Session

1. Start the server.
2. Open `index.html` and switch to the `Review` view if you want to resume an existing workflow immediately.
3. Use the saved-project picker or the `Resume Latest Workflow` action if a validated pilot project already exists.
4. Follow [first-simulation.md](./first-simulation.md).