# First Simulation Guide

This guide is written to produce a working first pilot simulation with the software as it exists today.

## The Most Reliable First Run Path

The fastest reliable path is to resume the validated saved project:

- project name: `Ligand OpenFF Pilot`
- project id pattern: `ligand-openff-pilot-*`

Use this path first because it avoids current selection-friction on the search page and starts from a known protein-ligand test case.

The current search page is still useful, but it is not yet the most reliable way to assemble a protein and ligand across multiple separate searches. For a guaranteed first simulation, start from the saved-project route in this guide.

## Goal

Run a complete short protein-ligand workflow through at least `NVT`, and optionally through `Production MD`.

## Before You Start

1. Install dependencies as described in [setup-and-run.md](./setup-and-run.md).
2. Start the integrated server.
3. Open the workflow page:

```text
http://127.0.0.1:8080/review.html
```

If you started the server on `8083`, use:

```text
http://127.0.0.1:8083/review.html
```

## Part 1: Open A Validated Starting Project

1. In the workflow header, find `Saved Projects`.
2. Select `Ligand OpenFF Pilot`.
3. Wait for the page to repopulate.
4. Confirm the project summary shows:
   - one structure
   - one compound
   - workflow type `Protein-Ligand in Water`

If the page opens into the empty state instead of the workflow, use one of these:

1. Click `Resume Latest Workflow`.
2. Click the `Ligand OpenFF Pilot` button in the recent project list.

## Part 2: Set A Conservative Environment Profile

Use a simple baseline environment for your first run:

- `pH`: `7.4`
- `Temperature (C)`: `25`
- `Ionic Strength (mM)`: `150`
- `Dominant Solvent`: `Aqueous Buffer`
- `Metal / Cofactor Context`: leave blank unless your target requires one

This keeps the run close to the validated pilot path.

## Part 3: Reset Or Reuse Existing Stage Outputs

You have two valid choices.

### Option A: Reuse Existing Outputs

Use this if you want to inspect a working project immediately.

1. Click each completed stage.
2. Inspect the runtime panel, logs, and checkpoint artifacts.
3. Open or export the generated files.

### Option B: Rebuild The Workflow Yourself

Use this if you want to run the first simulation end to end.

1. Click `Reset Workflow`.
2. Keep the same project selected.
3. Run stages from top to bottom.

The rest of this document assumes you chose Option B.

## Part 4: Run The Stages

### Stage 1: Import & Project Setup

Recommended settings:

- `Import mode`: `Auto download linked assets`
- `Artifact storage`: `Managed project workspace`

Action:

1. Open the `Import` stage.
2. Click `Run Stage`.
3. Wait for the checkpoint and logs to appear.

Success signs:

- stage status becomes `Complete`
- the backend project id is visible in the UI
- import artifacts appear in the runtime panel

### Stage 2: Protein Preparation

Recommended settings for the first local run:

- `Protein force field`: `AMBER14SB`
- `Protonation strategy`: `Auto from environment profile`
- `Keep cofactors and bound heterogens`: off unless you explicitly need them

Action:

1. Open `Protein Prep`.
2. Set the options above.
3. Click `Run Stage`.

Success signs:

- prepared protein checkpoint appears
- logs mention protein preparation or cleanup outputs

### Stage 3: Ligand Preparation

Recommended settings:

- `Primary ligand source`: `Use selected review compounds`
- `Parameterization route`: `OpenFF 2.2.1 + RDKit MMFF94 charges`
- `Enumerate protonation and tautomer states`: on

Action:

1. Open `Ligand Prep`.
2. Confirm the OpenFF route is selected.
3. Click `Run Stage`.

Success signs:

- the stage completes
- ligand parameter artifacts appear
- later stages can reference the ligand template without blocking

### Stage 4: Complex Assembly

Recommended first-run settings:

- `Assembly mode`: `Auto merge selected records`
- `Pose source`: `Selected review structure or pose`
- `Retain key crystallographic waters`: off

For the first run, do not upload a custom pose unless you specifically want to test reference or docked geometry.

Action:

1. Open `Complex`.
2. Keep the settings above.
3. Click `Run Stage`.

Success signs:

- assembled complex checkpoint appears
- `assembled-complex.pdb` is available as an artifact

### Stage 5: Box & Solvation

Recommended settings for a quick pilot run:

- `Box shape`: `Cubic`
- `Solvent padding (nm)`: `0.8` to `1.0`
- `Water model`: `TIP3P`

Action:

1. Open `Solvation`.
2. Apply the settings above.
3. Click `Run Stage`.

### Stage 6: Neutralization & Ions

Recommended settings:

- `Neutralize system charge automatically`: on
- `Target salt concentration (M)`: `0.15`
- `Ion pair`: `Sodium / Chloride`

Action:

1. Open `Ions`.
2. Confirm the values above.
3. Click `Run Stage`.

### Stage 7: Energy Minimization

Recommended first-run settings:

- `Maximum iterations`: `200` to `1000` for a quick validation run
- `Restraints during minimization`: `Backbone only` or `Protein heavy atoms`
- `Tolerance target`: `1000`

Action:

1. Open `Minimization`.
2. Set a conservative quick-run configuration.
3. Click `Run Stage`.

### Stage 8: NVT Equilibration

Recommended quick validation settings:

- `Duration (ps)`: `10`
- `Target temperature (K)`: `300`
- `Apply heavy atom restraints`: on

Action:

1. Open `NVT`.
2. Set the values above.
3. Click `Run Stage`.

Success signs:

- the stage completes
- `nvt.dcd` appears in the runtime artifacts
- state CSV and final PDB outputs are available

At this point you have already completed a useful first pilot simulation slice.

## Part 5: Continue To NPT And Production

If you want a fuller first run, continue with shorter pilot settings.

### NPT

Recommended pilot settings:

- `Duration (ps)`: `20`
- `Target pressure (bar)`: `1.0`
- `Release restraints during NPT`: on

### Production MD

Recommended pilot settings:

- `Duration (ns)`: `0.05`
- `Time step (fs)`: `2`
- `Write interval (ps)`: `5` to `10`

These values keep the run small enough for local CPU validation while still generating real trajectory artifacts.

## Part 6: Inspect Outputs

After each stage completes:

1. Open the stage card.
2. Read the checkpoint summary.
3. Use `Open` or `Export` on artifacts.

Important artifacts to check during a first run:

- assembled complex PDB
- solvation plan
- ionized system PDB
- minimized structure
- `nvt.dcd`
- state CSV files
- final structure PDB files
- OpenMM checkpoint files

## What A Successful First Simulation Looks Like

You can call the run successful when all of the following are true:

1. `Import`, `Protein Prep`, `Ligand Prep`, `Complex`, `Solvation`, `Ions`, `Minimization`, and `NVT` are complete.
2. The stage runtime panels show checkpoints rather than errors.
3. `NVT` generated a DCD trajectory artifact.
4. You can open or export artifacts directly from the review page.

## If You Want To Start From Search Instead

The search page can still be used, but the current software is most reliable when you open a validated saved project first.

If you do use `index.html`, use it with caution.

1. Prefer a search session that returns the structure and compound records you need together.
2. Select the items you want.
3. Click `Use Selected Items`.
4. Open `review.html` and verify the project summary immediately.

If the resulting selection is incomplete or the review page does not contain the protein-ligand pair you expected, return to the saved-project flow above. That is currently the most reliable first-run path.