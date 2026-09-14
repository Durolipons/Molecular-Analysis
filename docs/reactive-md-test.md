# Reactive MD Test Workflow — H + H₂ Exchange

This document is the complete specification for the canonical reactive MD validation test built into this workspace. It covers the reaction definition, force field, initial coordinates, simulation protocol, expected outputs, and automated validation checks.

Run this test to confirm that your engine correctly handles:

- bond breaking and bond forming in the same trajectory
- a custom reactive potential (Morse + switching)
- reaction coordinate tracking
- energy conservation under a reactive potential

---

## 1. Reaction Definition

### Elementary Reaction

```
H_A  +  H_B–H_C  →  H_A–H_B  +  H_C
```

| Symbol | Role |
|--------|------|
| H_A | Incoming hydrogen — approaches from −x |
| H_B | Bridge hydrogen — transfers the bond |
| H_C | Leaving hydrogen |

### Reaction Coordinate

$$\xi = r_{AB} - r_{BC}$$

| Phase | ξ (Å) | Description |
|-------|--------|-------------|
| Reactant | +1.26 | H_B–H_C bonded, H_A far |
| Transition state | 0.00 | symmetric, both bonds half-formed |
| Product | −1.26 | H_A–H_B bonded, H_C far |

### Qualitative PES (along the linear path)

```
Energy
  ↑
  |         TS ≈ +9.2 kcal/mol
  |        /‾‾\
  |       /    \
  |      /      \
  |_____/        \_____
  |
  +------ξ------→
 +1.3   0.0   −1.3
```

The surface is symmetric (identical reactant and product wells) and has a single saddle point on the linear reaction path.

---

## 2. Force Field Specification

### Reactive Potential Form

The potential is a sum of two bond terms with a switching function plus an endpoint repulsion:

$$V = S_{BC}(r_{BC}) \cdot V_\text{Morse}(r_{BC}) + [1 - S_{AB}(r_{AB})] \cdot V_\text{Morse}(r_{AB}) + V_\text{rep}(r_{AC})$$

The switching function is:

$$S(r) = \tfrac{1}{2}\left[1 + \tanh\!\left(\frac{r - r_\text{sw}}{w}\right)\right]$$

- $S(r) \to 1$ for $r \gg r_\text{sw}$ (bond broken)
- $S(r) \to 0$ for $r \ll r_\text{sw}$ (bond intact)

### Morse Bond Parameters

| Parameter | Symbol | Value | Units |
|-----------|--------|-------|-------|
| Dissociation energy | D_e | 4.747 | eV |
| Equilibrium distance | r_e | 0.742 | Å |
| Width parameter | α | 1.942 | Å⁻¹ |

$$V_\text{Morse}(r) = D_e \left[1 - e^{-\alpha(r - r_e)}\right]^2 - D_e$$

(Zero of energy = bonded minimum = −D_e.)

### Switching Parameters

| Parameter | Value | Notes |
|-----------|-------|-------|
| r_sw | 1.0 Å | Center of the switching region |
| w | 0.3 Å | Width (larger = smoother switch) |

### Endpoint Repulsion (H_A–H_C)

$$V_\text{rep}(r_{AC}) = A \cdot e^{-b \cdot r_{AC}}$$

| Parameter | Value |
|-----------|-------|
| A | 50.0 eV |
| b | 3.0 Å⁻¹ |

This prevents H_A and H_C from overlapping during the transfer.

### Atom and Simulation Parameters

| Parameter | Value |
|-----------|-------|
| Mass (all H) | 1.00794 amu |
| Recommended timestep | 0.05 fs |
| Integration method | Velocity Verlet (NVE) |
| Angle potentials | none (linear geometry) |
| Dihedral potentials | none |
| Nonbonded cutoff | n/a (only 3 atoms) |

---

## 3. Simulation Box and Initial Coordinates

### Cartesian Coordinates (Å)

```
# Atom  X       Y   Z
H_A    0.000   0.0  0.0
H_B    2.000   0.0  0.0
H_C    2.742   0.0  0.0
```

H_B–H_C distance = 0.742 Å ≈ r_e (H₂ equilibrium).  
H_A–H_B distance = 2.000 Å (H_A well outside the bonding region).

### Box

```
20.0 × 20.0 × 20.0 Å  (vacuum, no PBC required)
```

### Initial Velocities

| Atom | vx (Å/fs) | vy | vz | Notes |
|------|-----------|----|----|-------|
| H_A | +0.010 | 0 | 0 | KE ≈ 0.52 eV — just above the 0.40 eV barrier |
| H_B | 0 | 0 | 0 | |
| H_C | 0 | 0 | 0 | |

For ensemble studies, use Maxwell–Boltzmann velocities at T = 600 K (which is above the classical crossover temperature of ~400 K for H₂).

---

## 4. Full Workflow Steps (in this application)

Use the **Reactive MD Test (H+H₂ Exchange)** workflow type. Apply the **Reactive MD: H + H₂ Exchange** preset to pre-fill all stage parameters.

### Stage 1 — Import & Project Setup

- Workflow type: `Reactive MD Test (H+H₂ Exchange)`
- Import mode: `Keep only current review selections` (no external downloads)
- Artifact storage: `Managed project workspace`
- Stage note: pre-filled by the preset — contains the coordinate spec above

Action: write the 3-atom coordinate block to the project workspace as `h3_initial.xyz`.

### Stage 2 — Protein Preparation → Topology Build

Repurpose this stage to assign atom types and Morse parameters. The stage note should document which parameter set was used. No PDB repair is needed.

### Stage 3 — Ligand Preparation (Skipped)

Automatically marked optional for this workflow type. The H + H₂ system has no organic ligand — all three atoms are described entirely by the Morse reactive potential. No parameterization, state enumeration, or charge fitting is required.

### Stage 4 — Complex Assembly (Skipped)

Automatically marked optional for this workflow type. There is no protein–ligand complex to assemble. The three-atom system enters the simulation directly from the coordinates written in Stage 1.

### Stage 5 — Box & Solvation (Skipped)

Automatically marked optional/skipped for this workflow type — it is a gas-phase system.

### Stage 6 — Neutralization & Ions (Skipped)

Automatically skipped — gas-phase, no counterions.

### Stage 7 — Energy Minimization

Settings applied by the preset:

| Field | Value |
|-------|-------|
| Max iterations | 500 |
| Restraints | None |
| Tolerance | 10 kJ/mol·nm |

Expected outcome: H_B–H_C distance converges to ≈ 0.742 Å; H_A moves slightly outward.

### Stage 8 — NVT Equilibration → Reactive MD Integration

Settings applied by the preset:

| Field | Value |
|-------|-------|
| Duration | 10 ps |
| Temperature | 600 K |
| Heavy atom restraints | Off |
| Timestep (production) | 0.05 fs |

At 600 K, reaction crossing events should occur within the first few picoseconds.

### Stage 9 — NPT Equilibration → Reaction Coordinate Tracking

Settings applied by the preset:

| Field | Value |
|-------|-------|
| Duration | 50 ps |
| Timestep | 0.05 fs |
| Write interval | 0.1 ps |

Track ξ = r(A–B) − r(B–C) every frame.

### Stage 10 — Production MD

| Field | Value |
|-------|-------|
| Duration | 0.05 ns (50 ps) |
| Timestep | 0.05 fs |
| Write interval | 0.1 ps |

Run at least 100 independent trajectories for rate estimation.

### Stage 11 — Analysis & Reporting

- Track reaction crossing count (ξ sign changes)
- Plot ξ(t) time series
- Plot V(t) total energy to verify conservation
- Compute rate constant k from crossing frequency

---

## 5. Expected Outputs

### Energy Profile

| Configuration | V (eV) |
|---------------|--------|
| Reactants (H_B–H_C bonded) | 0.00 |
| Transition state (ξ = 0) | ≈ +0.40 |
| Products (H_A–H_B bonded) | 0.00 |

### Reaction Coordinate Evolution

A single deterministic trajectory starting with KE = 0.52 eV above the well:

```
ξ(t)
 +1.3 |____
      |    \_
      |      \  TS crossing (~0.5 ps)
  0.0 |       \/
      |         \___
 −1.3 |
      +------------→ t (ps)
```

After crossing, ξ oscillates around −1.26 Å (products). The system stays in the product well because the initial KE is only slightly above the barrier — there is insufficient energy for a second crossing in a single trajectory.

### What a Successful Run Looks Like

1. ξ starts near +1.26, crosses 0, stabilizes near −1.26 within ≤ 2 ps.
2. Total energy conserved to < 0.001 eV over 1 ps (NVE mode).
3. No atom separation > 15 Å (atoms stay in vacuum box).
4. r(B–C) relaxes from 0.742 → ~3 Å; r(A–B) shrinks from 2.0 → ~0.742 Å.

### Failure Modes

| Symptom | Likely Cause |
|---------|-------------|
| ξ never crosses 0 | Initial KE below barrier; check velocity of H_A |
| Energy drifts > 0.01 eV/ps | Timestep too large; reduce to 0.01 fs |
| H_A and H_C overlap | Endpoint repulsion disabled or too weak |
| r(B–C) oscillates but does not dissociate | Switching width w too large; sharpening the switch |
| Negative frequencies at minimum | Parameters inconsistent; recheck r_e and α |

---

## 6. Validation Tests

Implement these five automated checks after the run:

### Test 1 — Energy Conservation

```python
# NVE run, sample every 0.05 fs
E_total = kinetic_energy + potential_energy
delta_E = max(E_total) - min(E_total)
assert delta_E < 0.001 * abs(E_total.mean()), "Energy drift too large"
```

Pass threshold: < 0.1% drift over 1 ps.

### Test 2 — Reaction Observed

```python
xi = r_AB - r_BC
crossings = np.where(np.diff(np.sign(xi)))[0]
assert len(crossings) >= 1, "No TS crossing detected"
```

At T = 600 K, at least one crossing expected in a 10 ps trajectory for ≥ 90% of trajectories.

### Test 3 — Equilibrium Bond Length (Pre-reaction)

```python
# r_BC during first 0.1 ps (before reaction)
r_bc_early = r_BC[:int(0.1 / dt)]
assert abs(r_bc_early.mean() - 0.742) < 0.05, "H₂ equilibrium bond length wrong"
```

### Test 4 — Symmetry (Ensemble)

```python
# Over 100 trajectories, reactant→product and product→reactant should be equal
n_forward = sum(1 for xi in xi_trajectories if xi[0] > 0 and xi[-1] < 0)
n_reverse = sum(1 for xi in xi_trajectories if xi[0] < 0 and xi[-1] > 0)
assert abs(n_forward - n_reverse) < 0.1 * (n_forward + n_reverse), "Reaction asymmetric"
```

### Test 5 — No Atom Overlap

```python
r_min = min(r_AB.min(), r_BC.min(), r_AC.min())
assert r_min > 0.3, f"Atom overlap: minimum separation {r_min:.3f} Å"
```

---

## 7. Quick Start

1. Open the workspace and go to the **Review** tab.
2. In the **Workflow** section, click **Reset Workflow**.
3. Open the **Presets** dropdown → select **Reactive MD: H + H₂ Exchange** → click **Apply**.
4. Confirm the workflow type switched to **Reactive MD Test (H+H₂ Exchange)**.
5. Confirm that stages **Ligand Preparation**, **Complex Assembly**, **Box & Solvation**, and **Neutralization & Ions** are now marked **Optional** (automatically excluded for this workflow type).
6. Open **Import** → review the pre-filled coordinates in the Stage Note field.
7. Run stages in order: Import → Protein Prep → Minimization → NVT → Production → Analysis.

---

## 8. References

- Eyring H. (1935). *The activated complex in chemical reactions.* J. Chem. Phys. 3, 107.
- London F. (1929). *Zur Quantenmechanik der homöopolaren Valenzchemie.* Z. Elektrochem. 35, 552.
- Sato S. (1955). *On a new method of drawing the potential energy surface.* J. Chem. Phys. 23, 2465.
- Truhlar D.G. & Wyatt R.E. (1976). *History of H₃ kinetics.* Annu. Rev. Phys. Chem. 27, 1.
