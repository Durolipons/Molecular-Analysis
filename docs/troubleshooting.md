# Troubleshooting

## The Review Page Shows Only Search Or An Empty State

Possible causes:

- no current `selectedMolecules` state in the browser
- the page was opened directly without using the search page
- the saved project exists only in backend runtime state

What to do:

1. Open `review.html` on the same port as the running server.
2. Use the `Saved Projects` selector in the workflow header.
3. If the workflow is still hidden, click `Resume Latest Workflow`.
4. If needed, use a recent project button from the empty-state project list.

## Which URL Should I Use?

- Use `/` for the search page.
- Use `/review.html` for workflow execution, saved-project recovery, and artifact inspection.

Use the same port for both pages.

## The Server Starts On 8080 Sometimes And 8083 Other Times

That is expected when `PORT` is overridden.

- `npm start` uses `8080` by default.
- `$env:PORT=8083; npm start` uses `8083`.

Pick one port per session and use it consistently.

## The Backend Health Check Fails

Try:

```powershell
npm start
Invoke-RestMethod -Uri 'http://127.0.0.1:8080/api/health' -Method Get
```

If you are using port `8083`, replace `8080` with `8083`.

## I See An Unreadable Workflow Project Warning

Example behavior:

- the server skips an old corrupt project directory
- `skippedCount` is greater than zero in `/api/workflow/projects`

Impact:

- saved-project discovery still works
- readable projects are still returned
- the corrupt project is skipped instead of crashing discovery

What to do:

1. Continue using readable projects.
2. Remove or repair the corrupt legacy project folder later if you want a completely clean runtime directory.

## The Python Backend Fails Before Scientific Stages Run

Common causes:

- Python dependencies were not installed from `requirements-md.txt`
- the active Python runtime is not the expected one
- an environment issue is breaking `py -3`

Checks:

```powershell
py -3 -m pip install -r requirements-md.txt
py -3 -m py_compile .\backend\md_pipeline.py
```

If the scientific Python runtime is broken, `server.js` can still serve the UI, but real MD stages will fail when launched.

## A Stage Is Blocked

Typical reasons:

- no selected structure or protein
- no selected compound for ligand workflows
- required upstream stage is incomplete
- the backend is offline

What to do:

1. Confirm the project summary shows the expected structures and compounds.
2. Check that upstream stages are complete.
3. Use `Refresh State` on the stage.
4. Check the backend summary in the workflow summary cards.

## Complex Assembly Does Not Use The Pose I Expected

Check:

- `Pose source`
- `Docked/reference pose file`
- `Reference complex ligand residue`

If you upload a full reference-complex PDB and multiple HETATM ligand residues are found, use the residue chooser to force the intended residue.

## The First Simulation Feels Too Slow

For a quick pilot run:

- reduce minimization iterations
- keep NVT to `10 ps`
- keep NPT to `20 ps`
- keep production to `0.05 ns`

Run a short validation first, then scale up.

## Useful Development Commands

```powershell
node --check .\server.js
node --check .\js\review.js
py -3 -m py_compile .\backend\md_pipeline.py
Invoke-RestMethod -Uri 'http://127.0.0.1:8080/api/health' -Method Get
Invoke-RestMethod -Uri 'http://127.0.0.1:8080/api/workflow/projects' -Method Get
```