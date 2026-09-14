# Workflow Reference

This document describes the workflow stages and the main controls exposed on the Review workspace.

## Main Workflow Controls

The workflow page contains:

- `Project Name`
- `Workflow Type`
- `Simulation Engine`
- `Presets`
- `Saved Projects`
- `Reset Workflow`

Each stage detail panel also exposes:

- `Reset Stage`
- `Refresh State`
- `Run Stage` or `Rerun Stage`

## Workflow Types

| Value | Label | Description |
|-------|-------|-------------|
| `protein-water` | Protein in Water | Standard NVT/NPT equilibration of a solvated protein. |
| `protein-ligand-water` | Protein-Ligand in Water | Full protein-ligand complex with parameterized small molecule. |
| `reactive-md-test` | Reactive MD Test (H+H₂ Exchange) | Gas-phase 3-atom reactive MD validation. Solvation, ions, and complex assembly are automatically excluded. See [reactive-md-test.md](./reactive-md-test.md). |

## Presets

Presets fill stage parameters from a validated starting point. They do not overwrite an already-named saved project.

To apply a preset:

1. Select a preset from the **Presets** dropdown.
2. Click **Apply**.

| Preset | Workflow Type | Purpose |
|--------|--------------|---------|
| `Reactive MD: H + H₂ Exchange` | Reactive MD Test | Sets up the canonical 3-atom H exchange test. See [reactive-md-test.md](./reactive-md-test.md). |

## Stage Status Meanings

- `Ready`: the stage can be run with the current inputs.
- `Blocked`: required upstream data or selections are missing.
- `Queued` or `Running`: the stage is actively executing or waiting on a job.
- `Complete`: the stage finished successfully and has checkpoint or artifact data.
- `Optional`: the stage is currently not relevant for the selected workflow type.

## Stage Reference

### 1. Import & Project Setup

Purpose:

- create a managed project workspace
- capture selected structures and ligands
- write the initial project manifest

Main fields:

- `Import mode`
- `Artifact storage`
- `Stage note`

Expected outputs:

- source coordinate files
- metadata bundle
- project manifest

### 2. Protein Preparation

Purpose:

- repair and normalize the protein structure

Main fields:

- `Protein force field`
- `Protonation strategy`
- `Keep cofactors and bound heterogens`

Expected outputs:

- prepared protein coordinates
- topology-related metadata
- repair provenance

### 3. Ligand Preparation

Purpose:

- generate ligand coordinates and parameters

Main fields:

- `Primary ligand source`
- `Parameterization route`
- `Enumerate protonation and tautomer states`

Expected outputs:

- ligand coordinates
- ligand parameters
- state enumeration report

Recommended current route:

- `OpenFF 2.2.1 + RDKit MMFF94 charges`

### 4. Complex Assembly

Purpose:

- merge the prepared protein and ligand into a simulation-ready complex

Main fields:

- `Assembly mode`
- `Pose source`
- `Docked/reference pose file`
- `Reference complex ligand residue`
- `Retain key crystallographic waters`

Notes:

- Uploads can be `.pdb`, `.sdf`, `.mol`, or `.mol2`.
- A full reference-complex PDB can be uploaded and the backend will extract the ligand residue.
- If multiple ligand residues are found, the residue chooser will expose explicit options.
- The checkpoint card shows `Pose Source Type` and `Extracted Residue` when applicable.

### 5. Box & Solvation

Purpose:

- define the solvent box and water model

Main fields:

- `Box shape`
- `Solvent padding (nm)`
- `Water model`

Expected outputs:

- solvated coordinates or planning artifacts
- box dimensions
- solvent composition information

### 6. Neutralization & Ions

Purpose:

- neutralize charge and add salt

Main fields:

- `Neutralize system charge automatically`
- `Target salt concentration (M)`
- `Ion pair`

### 7. Energy Minimization

Purpose:

- relax clashes before dynamics

Main fields:

- `Maximum iterations`
- `Restraints during minimization`
- `Tolerance target`

### 8. NVT Equilibration

Purpose:

- stabilize temperature with short restrained dynamics

Main fields:

- `Duration (ps)`
- `Target temperature (K)`
- `Apply heavy atom restraints`

### 9. NPT Equilibration

Purpose:

- relax density and pressure before production

Main fields:

- `Duration (ps)`
- `Target pressure (bar)`
- `Release restraints during NPT`

### 10. Production MD

Purpose:

- run the main pilot trajectory

Main fields:

- `Duration (ns)`
- `Time step (fs)`
- `Write interval (ps)`

Typical outputs:

- trajectory file
- CSV state data
- final PDB
- OpenMM checkpoint

### 11. Analysis & Reporting

Purpose:

- capture the intended post-processing configuration for reporting and analysis

Main fields:

- `Include RMSD analysis`
- `Include hydrogen bond analysis`
- `Include ligand contact analysis`

Current status:

- present in the UI
- not yet fully wired to the backend as an executable scientific stage

## Saved Projects

The saved-project system is useful when you want to resume validated workflows without rebuilding selection state manually.

You can open a saved project from:

- the `Saved Projects` selector in the workflow header
- the `Resume Latest Workflow` button in the empty state
- the recent project list in the empty state

## Artifact Actions

When a stage has outputs, the runtime card exposes actions to:

- open text-based artifacts such as PDB, JSON, CSV, XML, and SDF
- export text or binary outputs such as DCD and checkpoint files
- inspect the primary artifact directly from the checkpoint card