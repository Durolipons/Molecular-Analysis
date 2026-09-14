import argparse
import datetime
import json
import math
import shutil
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from pdbfixer import PDBFixer
from rdkit import Chem
from rdkit.Chem import AllChem, Descriptors, rdFMCS, rdMolAlign, rdMolDescriptors

import openmm
from openmm import MonteCarloBarostat, XmlSerializer, unit
from openmm.app import DCDReporter, ForceField, Modeller, PDBFile, PME, Simulation, StateDataReporter


PROTEIN_FORCE_FIELD_FILES = {
    'amber14': ('amber14-all.xml', {
        'tip3p': 'amber14/tip3p.xml',
        'spce': 'amber14/spce.xml',
        'opc': 'amber14/opc.xml'
    }),
    'charmm36': ('charmm36.xml', {
        'tip3p': 'charmm36/water.xml',
        'spce': 'charmm36/water.xml',
        'opc': 'charmm36/water.xml'
    })
}
WATER_MODEL_NAMES = {
    'tip3p': 'tip3p',
    'spce': 'spce',
    'opc': 'opc'
}
STANDARD_PROTEIN_RESIDUES = {
    'ALA', 'ARG', 'ASN', 'ASP', 'CYS', 'CYX', 'GLN', 'GLU', 'GLY', 'HIS', 'HID', 'HIE', 'HIP',
    'ILE', 'LEU', 'LYS', 'MET', 'PHE', 'PRO', 'SER', 'THR', 'TRP', 'TYR', 'VAL', 'SEC', 'PYL'
}
STANDARD_NUCLEIC_RESIDUES = {
    'A', 'C', 'G', 'U', 'DA', 'DC', 'DG', 'DT'
}
BACKBONE_ATOM_NAMES = {'N', 'CA', 'C', 'O', 'P', "O5'", "C5'", "C4'", "C3'", "O3'"}
EXCLUDED_REFERENCE_POSE_RESIDUES = {
    'HOH', 'WAT', 'SOL', 'TIP', 'TIP3', 'TIP4', 'TIP5',
    'NA', 'K', 'CL', 'CA', 'MG', 'ZN', 'MN', 'FE', 'CU', 'CO', 'NI', 'IOD', 'BR', 'CS', 'RB', 'SR', 'BA', 'CD', 'HG'
}
MAX_SIMULATION_STEPS = 500000

# ─── Reactive MD: H + H₂ Exchange constants ──────────────────────────────────
_EV_TO_KJ_MOL  = 96.485                    # 1 eV = 96.485 kJ/mol
H3_DE_KJ_MOL   = 4.747 * _EV_TO_KJ_MOL   # Morse well depth, kJ/mol
H3_RE_NM       = 0.0742                    # H₂ equilibrium bond length, nm  (0.742 Å)
H3_ALP_NM      = 19.42                     # Morse range parameter, nm⁻¹     (1.942 Å⁻¹)
H3_RSW_NM      = 0.100                     # bond-switching centre, nm        (1.0 Å)
H3_WSW_NM      = 0.030                     # bond-switching width,  nm        (0.3 Å)
H3_AREP_KJ     = 50.0 * _EV_TO_KJ_MOL    # A–C endpoint repulsion amplitude, kJ/mol
H3_BREP_NM     = 30.0                      # A–C endpoint repulsion steepness, nm⁻¹  (3.0 Å⁻¹)
H3_MASS_AMU    = 1.00794                   # hydrogen mass, amu
H3_TIMESTEP_FS = 0.05                      # recommended NVE timestep, fs
# Initial positions (nm):  H_A=(0,0,0)  H_B=(0.2,0,0)  H_C=(0.2742,0,0)
H3_POSITIONS_NM = [(0.0000, 0.0, 0.0), (0.2000, 0.0, 0.0), (0.2742, 0.0, 0.0)]
# H_A initial velocity for production: 10 nm/ps = 0.1 Å/fs → KE ≈ 0.52 eV (above barrier)
H3_VA_PROD_NM_PS = 10.0


def main() -> int:
    parser = argparse.ArgumentParser(description='Run OpenMM-backed molecular workflow stages.')
    parser.add_argument('--stage', required=True)
    parser.add_argument('--payload', required=True)
    parser.add_argument('--result', required=True)
    args = parser.parse_args()

    payload_path = Path(args.payload)
    result_path = Path(args.result)
    payload = json.loads(payload_path.read_text(encoding='utf-8'))

    try:
        result = run_stage(args.stage, payload)
        write_json(result_path, result)
        return 0
    except Exception as error:
        log_message('error', str(error))
        return 1


def run_stage(stage_id: str, payload: dict) -> dict:
    stage_handlers = {
        'import': run_import,
        'protein-prep': run_protein_prep,
        'ligand-prep': run_ligand_prep,
        'complex-build': run_complex_build,
        'solvation': run_solvation,
        'ions': run_ions,
        'minimization': run_minimization,
        'nvt': run_nvt,
        'npt': run_npt,
        'production': run_production
    }

    if stage_id not in stage_handlers:
        raise ValueError(f'Stage {stage_id} is not implemented in the Python backend.')

    return stage_handlers[stage_id](payload)


def run_protein_prep(payload: dict) -> dict:
    if payload.get('workflowType') == 'reactive-md-test':
        return run_reactive_md_topology(payload)
    stage_context = get_stage_context(payload)
    stage_dir = stage_context['stage_dir']
    source_dir = stage_context['project_dir'] / 'sources'
    source_dir.mkdir(parents=True, exist_ok=True)

    structure_source = resolve_structure_source(payload)
    source_pdb_path = source_dir / f"{structure_source['identifier'].lower()}-source.pdb"
    fetch_structure_file(structure_source, source_pdb_path)
    log_message('info', f"Fetched structure source {structure_source['identifier']} from {structure_source['source_type']}.")

    config = get_stage_config(payload, 'protein-prep')
    environment = payload.get('environmentProfile') or {}
    ph_value = float(environment.get('ph', 7.4))
    keep_heterogens = bool(config.get('keepHeterogens', True))

    fixer = PDBFixer(filename=str(source_pdb_path))
    fixer.findMissingResidues()
    missing_residue_count = len(getattr(fixer, 'missingResidues', {}))
    fixer.findNonstandardResidues()
    nonstandard_residue_count = len(getattr(fixer, 'nonstandardResidues', []))
    if nonstandard_residue_count:
        fixer.replaceNonstandardResidues()
    if not keep_heterogens:
        fixer.removeHeterogens(keepWater=False)
    fixer.findMissingAtoms()
    missing_atom_count = len(getattr(fixer, 'missingAtoms', {}))
    fixer.addMissingAtoms()
    fixer.addMissingHydrogens(ph_value)

    prepared_pdb_path = stage_dir / 'prepared-protein.pdb'
    with prepared_pdb_path.open('w', encoding='utf-8') as handle:
        PDBFile.writeFile(fixer.topology, fixer.positions, handle, keepIds=True)

    metadata = {
        'source': structure_source,
        'generatedAt': iso_now(),
        'ph': ph_value,
        'forceField': normalize_force_field_name(config.get('forceField')),
        'requestedForceField': config.get('forceField', 'amber14'),
        'protonationStrategy': config.get('protonation', 'auto'),
        'keepHeterogens': keep_heterogens,
        'missingResidues': missing_residue_count,
        'missingAtoms': missing_atom_count,
        'nonstandardResidues': nonstandard_residue_count,
        'atomCount': sum(1 for _ in fixer.topology.atoms()),
        'residueCount': sum(1 for _ in fixer.topology.residues())
    }
    metadata_path = stage_dir / 'protein-prep-metadata.json'
    write_json(metadata_path, metadata)

    log_message('info', f"Prepared protein written to {prepared_pdb_path.name} with {metadata['atomCount']} atoms.")

    checkpoint = {
        'label': 'Protein structure prepared with PDBFixer',
        'summary': f"Prepared {structure_source['identifier']} at pH {ph_value:.1f} with {metadata['atomCount']} atoms ready for system building.",
        'generatedAt': iso_now(),
        'preparedStructurePath': to_relative_path(prepared_pdb_path, stage_context['root_dir']),
        'metadataPath': to_relative_path(metadata_path, stage_context['root_dir']),
        'sourceStructurePath': to_relative_path(source_pdb_path, stage_context['root_dir']),
        'sourceIdentifier': structure_source['identifier'],
        'forceField': metadata['forceField'],
        'keepHeterogens': keep_heterogens,
        'missingResidues': missing_residue_count,
        'missingAtoms': missing_atom_count,
        'nonstandardResidues': nonstandard_residue_count
    }
    checkpoint_path = stage_dir / 'protein-prep-checkpoint.json'
    write_json(checkpoint_path, checkpoint)

    return {
        'summary': 'Protein preparation completed with PDBFixer outputs.',
        'checkpoint': checkpoint,
        'artifactPaths': [
            to_relative_path(source_pdb_path, stage_context['root_dir']),
            to_relative_path(prepared_pdb_path, stage_context['root_dir']),
            to_relative_path(metadata_path, stage_context['root_dir']),
            to_relative_path(checkpoint_path, stage_context['root_dir'])
        ]
    }


def run_ligand_prep(payload: dict) -> dict:
    stage_context = get_stage_context(payload)
    stage_dir = stage_context['stage_dir']
    ligand_item = resolve_ligand_item(payload)
    if ligand_item is None:
        raise ValueError('Ligand preparation requires at least one PubChem or ChEMBL selection.')

    smiles = resolve_ligand_smiles(ligand_item)
    if not smiles:
        raise ValueError('Unable to determine a ligand SMILES string from the selected compound record.')

    molecule = Chem.MolFromSmiles(smiles)
    if molecule is None:
        raise ValueError('RDKit could not parse the ligand SMILES string.')

    molecule = Chem.AddHs(molecule)
    embed_status = AllChem.EmbedMolecule(molecule, AllChem.ETKDGv3())
    if embed_status != 0:
        raise ValueError('RDKit failed to generate a 3D ligand conformer.')
    optimize_status = AllChem.MMFFOptimizeMolecule(molecule)
    if optimize_status != 0:
        log_message('warn', 'MMFF optimization did not fully converge; continuing with the embedded ligand conformer.')

    ligand_sdf_path = stage_dir / 'ligand-prepared.sdf'
    ligand_pdb_path = stage_dir / 'ligand-prepared.pdb'
    writer = Chem.SDWriter(str(ligand_sdf_path))
    writer.write(molecule)
    writer.close()
    Chem.MolToPDBFile(molecule, str(ligand_pdb_path))

    config = get_stage_config(payload, 'ligand-prep')
    parameterization_route = config.get('parameterization', 'openff')
    parameterization_ready = False
    parameterization_note = ''
    parameterization_force_field = ''
    charge_method = ''
    template_path = None
    openff_json_path = None

    if parameterization_route == 'openff':
        try:
            parameterization = parameterize_ligand_openff(molecule, ligand_item, stage_dir)
            parameterization_ready = True
            parameterization_note = parameterization['note']
            parameterization_force_field = parameterization['forcefield']
            charge_method = parameterization['chargeMethod']
            template_path = parameterization['templatePath']
            openff_json_path = parameterization['openffJsonPath']
            log_message('info', f"Validated ligand parameterization with {parameterization_force_field} using {charge_method.upper()} charges.")
        except Exception as error:
            parameterization_note = (
                'Ligand coordinates were generated, but OpenFF parameterization could not be completed '
                f'on this runtime: {error}'
            )
            log_message('warn', parameterization_note)
    else:
        parameterization_note = (
            f"{parameterization_route.upper()} compatibility is not wired for local Windows execution yet. "
            'Choose the OpenFF route to produce a parameterized ligand template.'
        )

    metadata = {
        'generatedAt': iso_now(),
        'title': ligand_item.get('title', 'Ligand'),
        'database': ligand_item.get('database', 'Unknown'),
        'smiles': smiles,
        'formula': rdMolDescriptors.CalcMolFormula(molecule),
        'exactMass': Descriptors.ExactMolWt(molecule),
        'formalCharge': Chem.GetFormalCharge(molecule),
        'parameterizationRoute': parameterization_route,
        'parameterizationReady': parameterization_ready,
        'parameterizationNote': parameterization_note,
        'parameterizationForceField': parameterization_force_field,
        'chargeMethod': charge_method,
        'templatePath': to_relative_path(template_path, stage_context['root_dir']) if template_path else '',
        'openffJsonPath': to_relative_path(openff_json_path, stage_context['root_dir']) if openff_json_path else ''
    }
    metadata_path = stage_dir / 'ligand-prep-metadata.json'
    write_json(metadata_path, metadata)

    log_message('info', f"Prepared ligand coordinates from {ligand_item.get('database', 'compound source')} using RDKit.")

    checkpoint_summary = (
        f"Prepared 3D coordinates and an OpenFF ligand template for {ligand_item.get('title', 'selected ligand')}."
        if parameterization_ready
        else f"Prepared 3D coordinates for {ligand_item.get('title', 'selected ligand')} and stored exportable artifacts."
    )
    checkpoint = {
        'label': 'Ligand coordinates prepared',
        'summary': checkpoint_summary,
        'generatedAt': iso_now(),
        'ligandSdfPath': to_relative_path(ligand_sdf_path, stage_context['root_dir']),
        'ligandPdbPath': to_relative_path(ligand_pdb_path, stage_context['root_dir']),
        'metadataPath': to_relative_path(metadata_path, stage_context['root_dir']),
        'parameterizationReady': parameterization_ready,
        'parameterizationNote': parameterization_note,
        'parameterizationRoute': parameterization_route,
        'parameterizationForceField': parameterization_force_field,
        'chargeMethod': charge_method,
        'ligandTemplatePath': to_relative_path(template_path, stage_context['root_dir']) if template_path else '',
        'openffJsonPath': to_relative_path(openff_json_path, stage_context['root_dir']) if openff_json_path else '',
        'smiles': smiles
    }
    checkpoint_path = stage_dir / 'ligand-prep-checkpoint.json'
    write_json(checkpoint_path, checkpoint)

    artifact_paths = [
        to_relative_path(ligand_sdf_path, stage_context['root_dir']),
        to_relative_path(ligand_pdb_path, stage_context['root_dir']),
        to_relative_path(metadata_path, stage_context['root_dir'])
    ]
    if template_path:
        artifact_paths.append(to_relative_path(template_path, stage_context['root_dir']))
    if openff_json_path:
        artifact_paths.append(to_relative_path(openff_json_path, stage_context['root_dir']))
    artifact_paths.append(to_relative_path(checkpoint_path, stage_context['root_dir']))

    return {
        'summary': 'Ligand preparation completed with RDKit coordinates and OpenFF-compatible parameter metadata.',
        'checkpoint': checkpoint,
        'artifactPaths': artifact_paths
    }


def run_complex_build(payload: dict) -> dict:
    stage_context = get_stage_context(payload)
    stage_dir = stage_context['stage_dir']
    workflow_type = payload.get('workflowType', 'protein-water')
    protein_checkpoint = require_stage_checkpoint(payload, 'protein-prep')
    prepared_structure_path = resolve_artifact_path(payload, protein_checkpoint['preparedStructurePath'])

    if workflow_type == 'protein-water':
        complex_path = stage_dir / 'assembled-complex.pdb'
        shutil.copyfile(prepared_structure_path, complex_path)
        assembly_report = {
            'generatedAt': iso_now(),
            'mode': 'protein-only-pass-through',
            'note': 'Protein-only workflow promoted the prepared protein directly into the assembly stage.'
        }
        report_path = stage_dir / 'complex-build-report.json'
        write_json(report_path, assembly_report)
        checkpoint = {
            'label': 'Protein-only assembly ready',
            'summary': 'Protein-only workflow promoted the prepared structure to the assembly stage.',
            'generatedAt': iso_now(),
            'complexPdbPath': to_relative_path(complex_path, stage_context['root_dir']),
            'reportPath': to_relative_path(report_path, stage_context['root_dir'])
        }
        checkpoint_path = stage_dir / 'complex-build-checkpoint.json'
        write_json(checkpoint_path, checkpoint)
        return {
            'summary': 'Protein-only complex assembly completed.',
            'checkpoint': checkpoint,
            'artifactPaths': [
                to_relative_path(complex_path, stage_context['root_dir']),
                to_relative_path(report_path, stage_context['root_dir']),
                to_relative_path(checkpoint_path, stage_context['root_dir'])
            ]
        }

    ligand_checkpoint = require_stage_checkpoint(payload, 'ligand-prep')
    if not ligand_checkpoint.get('parameterizationReady', False):
        raise ValueError(
            'Ligand coordinates are available, but full complex assembly for MD requires ligand parameterization support that is not available on this runtime.'
        )

    config = get_stage_config(payload, 'complex-build')
    ligand_pdb_path = resolve_artifact_path(payload, ligand_checkpoint['ligandPdbPath'])
    protein_pdb = PDBFile(str(prepared_structure_path))
    pose_source = str(config.get('poseSource', 'selected') or 'selected')
    pose_import_path = str(config.get('poseImportPath', '') or '').strip()
    selected_reference_residue_id = str(config.get('referenceResidueId', '') or '').strip()
    pose_artifact_paths: list[str] = []

    if pose_import_path:
        aligned_ligand_pdb_path, placement_report, pose_artifact_paths = materialize_imported_ligand_pose(
            payload,
            ligand_checkpoint,
            pose_import_path,
            stage_context['stage_dir'],
            selected_reference_residue_id
        )
        ligand_pdb = PDBFile(str(aligned_ligand_pdb_path))
        translated_ligand_positions = ligand_pdb.positions
        assembly_mode = 'imported-ligand-pose'
        log_message('info', f"Aligned the prepared ligand to imported {pose_source} pose coordinates from {pose_import_path}.")
    else:
        if pose_source in {'docked', 'reference'} or str(config.get('assemblyMode', 'auto') or 'auto') == 'reference':
            raise ValueError(
                'Complex Assembly is configured to use a docked or reference pose, but no pose import path was provided.'
            )

        ligand_pdb = PDBFile(str(ligand_pdb_path))
        translated_ligand_positions, placement_report = position_ligand_for_complex(
            protein_pdb.positions,
            ligand_pdb.positions,
            clearance_nm=0.45
        )
        assembly_mode = 'heuristic-ligand-placement'

    modeller = Modeller(protein_pdb.topology, protein_pdb.positions)
    modeller.add(ligand_pdb.topology, translated_ligand_positions)

    complex_path = stage_dir / 'assembled-complex.pdb'
    with complex_path.open('w', encoding='utf-8') as handle:
        PDBFile.writeFile(modeller.topology, modeller.positions, handle, keepIds=True)

    assembly_report = {
        'generatedAt': iso_now(),
        'mode': assembly_mode,
        'assemblyMode': config.get('assemblyMode', 'auto'),
        'poseSource': pose_source,
        'poseImportPath': pose_import_path,
        'retainWaters': bool(config.get('retainWaters', False)),
        'parameterizationRoute': ligand_checkpoint.get('parameterizationRoute', 'openff'),
        'parameterizationForceField': ligand_checkpoint.get('parameterizationForceField', 'openff-2.2.1'),
        'chargeMethod': ligand_checkpoint.get('chargeMethod', 'mmff94'),
        'ligandTemplatePath': ligand_checkpoint.get('ligandTemplatePath', ''),
        'ligandPlacementNm': placement_report,
        'note': (
            'Applied imported docked/reference pose geometry to the prepared ligand before assembly.'
            if pose_import_path else
            'No docked or reference pose was available in the current project, so the ligand was '
            'placed beside the prepared protein using a clash-reducing heuristic offset. '
            'Review the assembled coordinates before long production campaigns.'
        )
    }
    report_path = stage_dir / 'complex-build-report.json'
    write_json(report_path, assembly_report)

    checkpoint = {
        'label': 'Protein-ligand complex assembled',
        'summary': 'Merged the prepared protein with a parameterized ligand and wrote a simulation-ready complex PDB.',
        'generatedAt': iso_now(),
        'complexPdbPath': to_relative_path(complex_path, stage_context['root_dir']),
        'reportPath': to_relative_path(report_path, stage_context['root_dir']),
        'poseSource': pose_source,
        'poseImportPath': pose_import_path,
        'poseSourceType': placement_report.get('sourceType', ''),
        'extractedResidueId': placement_report.get('extractedResidueId', ''),
        'extractedResidueName': placement_report.get('extractedResidueName', ''),
        'parameterizationRoute': ligand_checkpoint.get('parameterizationRoute', 'openff'),
        'parameterizationForceField': ligand_checkpoint.get('parameterizationForceField', 'openff-2.2.1'),
        'chargeMethod': ligand_checkpoint.get('chargeMethod', 'mmff94')
    }
    checkpoint_path = stage_dir / 'complex-build-checkpoint.json'
    write_json(checkpoint_path, checkpoint)
    log_message('info', (
        'Assembled a protein-ligand complex with imported pose geometry for downstream solvation.'
        if pose_import_path else
        'Assembled a protein-ligand complex with heuristic ligand placement for downstream solvation.'
    ))

    return {
        'summary': (
            'Protein-ligand complex assembly completed using imported pose geometry and a parameterized ligand template.'
            if pose_import_path else
            'Protein-ligand complex assembly completed with a parameterized ligand template.'
        ),
        'checkpoint': checkpoint,
        'artifactPaths': [
            to_relative_path(complex_path, stage_context['root_dir']),
            to_relative_path(report_path, stage_context['root_dir']),
            to_relative_path(checkpoint_path, stage_context['root_dir']),
            *pose_artifact_paths
        ]
    }


def run_solvation(payload: dict) -> dict:
    stage_context = get_stage_context(payload)
    stage_dir = stage_context['stage_dir']
    input_path = resolve_structure_for_system_build(payload)
    pdb_file = PDBFile(str(input_path))

    config = get_stage_config(payload, 'solvation')
    padding_nm = float(config.get('paddingNm', 1.0))
    water_model = config.get('waterModel', 'tip3p')
    box_shape = config.get('boxShape', 'dodecahedron')

    dimensions = compute_box_dimensions_nm(pdb_file.positions, padding_nm)
    plan = {
        'generatedAt': iso_now(),
        'inputStructurePath': to_relative_path(input_path, stage_context['root_dir']),
        'paddingNm': padding_nm,
        'boxShape': box_shape,
        'waterModel': water_model,
        'boxDimensionsNm': dimensions
    }
    plan_path = stage_dir / 'solvation-plan.json'
    write_json(plan_path, plan)
    log_message('info', f"Computed a {box_shape} solvation plan with {padding_nm:.2f} nm padding.")

    checkpoint = {
        'label': 'Solvation plan ready',
        'summary': f"Prepared a {box_shape} box plan with {padding_nm:.2f} nm padding for downstream water and ion placement.",
        'generatedAt': iso_now(),
        'planPath': to_relative_path(plan_path, stage_context['root_dir']),
        'waterModel': water_model,
        'boxShape': box_shape,
        'paddingNm': padding_nm,
        'boxDimensionsNm': dimensions
    }
    checkpoint_path = stage_dir / 'solvation-checkpoint.json'
    write_json(checkpoint_path, checkpoint)

    return {
        'summary': 'Solvation planning completed.',
        'checkpoint': checkpoint,
        'artifactPaths': [
            to_relative_path(plan_path, stage_context['root_dir']),
            to_relative_path(checkpoint_path, stage_context['root_dir'])
        ]
    }


def run_ions(payload: dict) -> dict:
    stage_context = get_stage_context(payload)
    stage_dir = stage_context['stage_dir']
    base_structure_path = resolve_structure_for_system_build(payload)
    solvation_checkpoint = require_stage_checkpoint(payload, 'solvation')
    pdb_file = PDBFile(str(base_structure_path))
    modeller = Modeller(pdb_file.topology, pdb_file.positions)

    protein_force_field = get_stage_config(payload, 'protein-prep').get('forceField', 'amber14')
    water_model = solvation_checkpoint.get('waterModel', 'tip3p')
    forcefield, resolved_force_field = build_force_field(protein_force_field, water_model, payload)

    ion_config = get_stage_config(payload, 'ions')
    padding_nm = float(solvation_checkpoint.get('paddingNm', 1.0))
    salt_molar = float(ion_config.get('saltConcentration', 0.15))
    neutralize = bool(ion_config.get('neutralize', True))
    positive_ion, negative_ion = resolve_ion_pair(ion_config.get('ionPair', 'na-cl'))

    modeller.addSolvent(
        forcefield,
        model=WATER_MODEL_NAMES.get(water_model, 'tip3p'),
        padding=padding_nm * unit.nanometer,
        ionicStrength=salt_molar * unit.molar,
        neutralize=neutralize,
        positiveIon=positive_ion,
        negativeIon=negative_ion
    )

    ionized_pdb_path = stage_dir / 'ionized-system.pdb'
    with ionized_pdb_path.open('w', encoding='utf-8') as handle:
        PDBFile.writeFile(modeller.topology, modeller.positions, handle, keepIds=True)

    topology_summary = {
        'generatedAt': iso_now(),
        'resolvedForceField': resolved_force_field,
        'waterModel': water_model,
        'saltConcentrationM': salt_molar,
        'neutralize': neutralize,
        'positiveIon': positive_ion,
        'negativeIon': negative_ion,
        'atomCount': sum(1 for _ in modeller.topology.atoms()),
        'residueCount': sum(1 for _ in modeller.topology.residues())
    }
    summary_path = stage_dir / 'ionized-system-summary.json'
    write_json(summary_path, topology_summary)
    log_message('info', f"Built ionized system with {topology_summary['atomCount']} atoms using {resolved_force_field}.")

    checkpoint = {
        'label': 'Ionized solvated system ready',
        'summary': f"Added solvent and ions at {salt_molar:.2f} M for downstream minimization.",
        'generatedAt': iso_now(),
        'ionizedStructurePath': to_relative_path(ionized_pdb_path, stage_context['root_dir']),
        'summaryPath': to_relative_path(summary_path, stage_context['root_dir']),
        'resolvedForceField': resolved_force_field,
        'waterModel': water_model,
        'saltConcentrationM': salt_molar,
        'atomCount': topology_summary['atomCount']
    }
    checkpoint_path = stage_dir / 'ions-checkpoint.json'
    write_json(checkpoint_path, checkpoint)

    return {
        'summary': 'Ionized system generation completed.',
        'checkpoint': checkpoint,
        'artifactPaths': [
            to_relative_path(ionized_pdb_path, stage_context['root_dir']),
            to_relative_path(summary_path, stage_context['root_dir']),
            to_relative_path(checkpoint_path, stage_context['root_dir'])
        ]
    }


def run_minimization(payload: dict) -> dict:
    if payload.get('workflowType') == 'reactive-md-test':
        return run_reactive_md_minimization(payload)
    stage_context = get_stage_context(payload)
    stage_dir = stage_context['stage_dir']
    ion_checkpoint = require_stage_checkpoint(payload, 'ions')
    ionized_structure_path = resolve_artifact_path(payload, ion_checkpoint['ionizedStructurePath'])
    pdb_file = PDBFile(str(ionized_structure_path))

    protein_force_field = get_stage_config(payload, 'protein-prep').get('forceField', 'amber14')
    water_model = ion_checkpoint.get('waterModel', 'tip3p')
    forcefield, resolved_force_field = build_force_field(protein_force_field, water_model, payload)
    config = get_stage_config(payload, 'minimization')
    system = create_system(forcefield, pdb_file.topology)
    apply_position_restraints(system, pdb_file.topology, pdb_file.positions, config.get('restraintMode', 'protein-heavy'))
    integrator = openmm.LangevinMiddleIntegrator(300 * unit.kelvin, 1.0 / unit.picosecond, 0.002 * unit.picoseconds)
    simulation = create_simulation(pdb_file.topology, system, integrator)
    simulation.context.setPositions(pdb_file.positions)
    simulation.minimizeEnergy(
        tolerance=float(config.get('tolerance', 1000)) * unit.kilojoule_per_mole / unit.nanometer,
        maxIterations=int(float(config.get('maxIterations', 5000)))
    )

    minimized_state = simulation.context.getState(getPositions=True, getEnergy=True)
    minimized_positions = minimized_state.getPositions()
    minimized_pdb_path = stage_dir / 'minimized-system.pdb'
    with minimized_pdb_path.open('w', encoding='utf-8') as handle:
        PDBFile.writeFile(pdb_file.topology, minimized_positions, handle, keepIds=True)

    system_xml_path = stage_dir / 'minimization-system.xml'
    system_xml_path.write_text(XmlSerializer.serialize(system), encoding='utf-8')
    checkpoint_path = stage_dir / 'minimization.chk'
    simulation.saveCheckpoint(str(checkpoint_path))

    potential_energy = minimized_state.getPotentialEnergy().value_in_unit(unit.kilojoule_per_mole)
    summary = {
        'generatedAt': iso_now(),
        'resolvedForceField': resolved_force_field,
        'potentialEnergyKJPerMol': potential_energy,
        'restraintMode': config.get('restraintMode', 'protein-heavy')
    }
    summary_path = stage_dir / 'minimization-summary.json'
    write_json(summary_path, summary)
    log_message('info', f"Minimization completed with potential energy {potential_energy:.2f} kJ/mol.")

    checkpoint = {
        'label': 'Energy minimization complete',
        'summary': f"Minimized the solvated system with final potential energy {potential_energy:.2f} kJ/mol.",
        'generatedAt': iso_now(),
        'minimizedStructurePath': to_relative_path(minimized_pdb_path, stage_context['root_dir']),
        'systemXmlPath': to_relative_path(system_xml_path, stage_context['root_dir']),
        'openmmCheckpointPath': to_relative_path(checkpoint_path, stage_context['root_dir']),
        'summaryPath': to_relative_path(summary_path, stage_context['root_dir']),
        'potentialEnergyKJPerMol': potential_energy,
        'resolvedForceField': resolved_force_field
    }
    checkpoint_record_path = stage_dir / 'minimization-checkpoint.json'
    write_json(checkpoint_record_path, checkpoint)

    return {
        'summary': 'Energy minimization finished with OpenMM outputs.',
        'checkpoint': checkpoint,
        'artifactPaths': [
            to_relative_path(minimized_pdb_path, stage_context['root_dir']),
            to_relative_path(system_xml_path, stage_context['root_dir']),
            to_relative_path(checkpoint_path, stage_context['root_dir']),
            to_relative_path(summary_path, stage_context['root_dir']),
            to_relative_path(checkpoint_record_path, stage_context['root_dir'])
        ]
    }


def run_nvt(payload: dict) -> dict:
    if payload.get('workflowType') == 'reactive-md-test':
        return run_reactive_md_stage(payload, 'nvt')
    return run_md_stage(payload, 'nvt', previous_stage_id='minimization', stage_label='NVT equilibration',
                        duration_unit='ps', add_barostat=False)


def run_npt(payload: dict) -> dict:
    if payload.get('workflowType') == 'reactive-md-test':
        return run_reactive_md_stage(payload, 'npt')
    return run_md_stage(payload, 'npt', previous_stage_id='nvt', stage_label='NPT equilibration',
                        duration_unit='ps', add_barostat=True)


def run_production(payload: dict) -> dict:
    if payload.get('workflowType') == 'reactive-md-test':
        return run_reactive_md_stage(payload, 'production')
    return run_md_stage(payload, 'production', previous_stage_id='npt', stage_label='Production MD',
                        duration_unit='ns', add_barostat=True)


# ─── Reactive MD: H + H₂ Exchange implementation ────────────────────────────

def run_import(payload: dict) -> dict:
    """Handle the import stage for all workflow types.

    For reactive-md-test: writes a project manifest describing the 3-atom H₃ system.
    For other workflow types: records the selected molecules in a manifest file.
    """
    stage_context = get_stage_context(payload)
    stage_dir = stage_context['stage_dir']
    root_dir = stage_context['root_dir']
    workflow_type = payload.get('workflowType', '')

    if workflow_type == 'reactive-md-test':
        manifest = {
            'workflowType': 'reactive-md-test',
            'system': 'H₃ linear exchange: H_A + H_B–H_C → H_A–H_B + H_C',
            'atomCount': 3,
            'atoms': [
                {'label': 'H_A', 'role': 'incoming', 'x_angstrom': 0.000, 'y_angstrom': 0.0, 'z_angstrom': 0.0},
                {'label': 'H_B', 'role': 'bridge',   'x_angstrom': 2.000, 'y_angstrom': 0.0, 'z_angstrom': 0.0},
                {'label': 'H_C', 'role': 'leaving',  'x_angstrom': 2.742, 'y_angstrom': 0.0, 'z_angstrom': 0.0},
            ],
            'potential': 'Morse + bond-switching (H_AB, H_BC) + exponential repulsion (H_AC)',
            'reactionCoordinate': 'xi = r_AB - r_BC  (Å)',
            'generatedAt': iso_now(),
        }
        manifest_path = stage_dir / 'import-manifest.json'
        write_json(manifest_path, manifest)
        log_message('info', 'Reactive MD test import: H₃ exchange system manifest written.')
        checkpoint = {
            'label': 'Reactive MD import complete',
            'summary': 'H₃ exchange system ready for topology build.',
            'generatedAt': iso_now(),
            'workflowType': 'reactive-md-test',
            'manifestPath': to_relative_path(manifest_path, root_dir),
        }
        checkpoint_path = stage_dir / 'import-checkpoint.json'
        write_json(checkpoint_path, checkpoint)
        return {
            'summary': 'Reactive MD test system imported.',
            'checkpoint': checkpoint,
            'artifactPaths': [
                to_relative_path(manifest_path, root_dir),
                to_relative_path(checkpoint_path, root_dir),
            ],
        }

    # Standard workflows: record selected molecule metadata
    selected = payload.get('selectedMolecules') or []
    manifest = {
        'workflowType': workflow_type,
        'selectedMoleculeCount': len(selected),
        'molecules': [
            {'title': item.get('title', ''), 'database': item.get('database', ''), 'id': item.get('id', '')}
            for item in selected
        ],
        'generatedAt': iso_now(),
    }
    manifest_path = stage_dir / 'import-manifest.json'
    write_json(manifest_path, manifest)
    log_message('info', f'Import stage: recorded {len(selected)} selected molecule(s).')
    checkpoint = {
        'label': 'Import complete',
        'summary': f'Recorded {len(selected)} molecule(s) for the workflow.',
        'generatedAt': iso_now(),
        'manifestPath': to_relative_path(manifest_path, root_dir),
        'selectedMoleculeCount': len(selected),
    }
    checkpoint_path = stage_dir / 'import-checkpoint.json'
    write_json(checkpoint_path, checkpoint)
    return {
        'summary': f'Import stage recorded {len(selected)} molecule(s).',
        'checkpoint': checkpoint,
        'artifactPaths': [
            to_relative_path(manifest_path, root_dir),
            to_relative_path(checkpoint_path, root_dir),
        ],
    }


def build_reactive_h3_topology():
    """Return a minimal 3-atom OpenMM Topology for the linear H₃ system (HA–HB–HC)."""
    topology = openmm.app.Topology()
    chain = topology.addChain()
    residue = topology.addResidue('H3', chain)
    h_element = openmm.app.element.hydrogen
    topology.addAtom('HA', h_element, residue)
    topology.addAtom('HB', h_element, residue)
    topology.addAtom('HC', h_element, residue)
    return topology


def _reactive_h3_params(payload: dict) -> dict:
    """Read reactive H3 parameters from the protein-prep stage config (with H3_* fallbacks)."""
    config = get_stage_config(payload, 'protein-prep')
    return {
        'mass_amu': float(config.get('reactiveAtomMassAmu', H3_MASS_AMU)),
        'De_kj_mol': float(config.get('reactiveMorseDeEv', H3_DE_KJ_MOL / _EV_TO_KJ_MOL)) * _EV_TO_KJ_MOL,
        're_nm': float(config.get('reactiveMorseReNm', H3_RE_NM)),
        'alpha_inv_nm': float(config.get('reactiveMorseAlphaInvNm', H3_ALP_NM)),
        'rsw_nm': float(config.get('reactiveSwitchRswNm', H3_RSW_NM)),
        'wsw_nm': float(config.get('reactiveSwitchWswNm', H3_WSW_NM)),
        'Arep_kj_mol': float(config.get('reactiveRepAmpEv', H3_AREP_KJ / _EV_TO_KJ_MOL)) * _EV_TO_KJ_MOL,
        'brep_inv_nm': float(config.get('reactiveRepSteepnessInvNm', H3_BREP_NM)),
        'pos_a_x_nm': float(config.get('reactivePosAxNm', H3_POSITIONS_NM[0][0])),
        'pos_b_x_nm': float(config.get('reactivePosBxNm', H3_POSITIONS_NM[1][0])),
        'pos_c_x_nm': float(config.get('reactivePosCxNm', H3_POSITIONS_NM[2][0])),
    }


def build_reactive_h3_system(params: dict = None) -> openmm.System:
    """Build the OpenMM System for the H + H₂ → H₂ + H reactive MD test.

    Force field:
      - Morse + bond-switching on both the H_A–H_B and H_B–H_C pairs
        using (1 − S(r)) ⋅ V_Morse(r) where S(r) = ½(1 + tanh((r − r_sw)/w))
      - Exponential repulsion on the H_A–H_C endpoint pair

    All quantities are in OpenMM native units (nm, kJ/mol).
    """
    if params is None:
        params = {
            'mass_amu': H3_MASS_AMU,
            'De_kj_mol': H3_DE_KJ_MOL,
            're_nm': H3_RE_NM,
            'alpha_inv_nm': H3_ALP_NM,
            'rsw_nm': H3_RSW_NM,
            'wsw_nm': H3_WSW_NM,
            'Arep_kj_mol': H3_AREP_KJ,
            'brep_inv_nm': H3_BREP_NM,
        }
    system = openmm.System()
    for _ in range(3):
        system.addParticle(params['mass_amu'] * unit.amu)

    # Morse + bond-switching:  (1 − S(r)) ⋅ [De⋅(1 − exp(−α(r−re)))² − De]
    # where S(r) = 0.5⋅(1 + tanh((r − rsw)/wsw))
    # so (1−S) = 0.5⋅(1 − tanh((r − rsw)/wsw)) → 1 when bonded, 0 when dissociated
    morse_expr = (
        '(0.5*(1 - tanh((r - h3_rsw)/h3_wsw))) * '
        '(h3_De*(1 - exp(-h3_alp*(r - h3_re)))^2 - h3_De)'
    )
    morse_force = openmm.CustomBondForce(morse_expr)
    morse_force.addGlobalParameter('h3_De',  params['De_kj_mol'])
    morse_force.addGlobalParameter('h3_re',  params['re_nm'])
    morse_force.addGlobalParameter('h3_alp', params['alpha_inv_nm'])
    morse_force.addGlobalParameter('h3_rsw', params['rsw_nm'])
    morse_force.addGlobalParameter('h3_wsw', params['wsw_nm'])
    morse_force.addBond(0, 1)   # H_A – H_B
    morse_force.addBond(1, 2)   # H_B – H_C
    system.addForce(morse_force)

    # A–C endpoint repulsion: V_rep = A ⋅ exp(−b ⋅ r)
    repul_expr = 'h3_Arep * exp(-h3_brep * r)'
    repul_force = openmm.CustomBondForce(repul_expr)
    repul_force.addGlobalParameter('h3_Arep', params['Arep_kj_mol'])
    repul_force.addGlobalParameter('h3_brep', params['brep_inv_nm'])
    repul_force.addBond(0, 2)   # H_A – H_C
    system.addForce(repul_force)

    return system


def run_reactive_md_topology(payload: dict) -> dict:
    """protein-prep handler for reactive-md-test: build the H₃ system topology."""
    stage_context = get_stage_context(payload)
    stage_dir = stage_context['stage_dir']
    root_dir = stage_context['root_dir']

    params = _reactive_h3_params(payload)
    topology = build_reactive_h3_topology()
    system = build_reactive_h3_system(params)

    pos_nm = [
        (params['pos_a_x_nm'], 0.0, 0.0),
        (params['pos_b_x_nm'], 0.0, 0.0),
        (params['pos_c_x_nm'], 0.0, 0.0),
    ]
    positions = unit.Quantity(
        [openmm.Vec3(*coords) for coords in pos_nm],
        unit.nanometer
    )

    # Write initial PDB (topology + positions)
    initial_pdb_path = stage_dir / 'h3-initial.pdb'
    with initial_pdb_path.open('w', encoding='utf-8') as handle:
        PDBFile.writeFile(topology, positions, handle)

    # Serialize the system for later stages
    system_xml_path = stage_dir / 'h3-system.xml'
    system_xml_path.write_text(XmlSerializer.serialize(system), encoding='utf-8')

    # Write a human-readable XYZ file (positions in Å)
    a_ang = params['pos_a_x_nm'] * 10.0
    b_ang = params['pos_b_x_nm'] * 10.0
    c_ang = params['pos_c_x_nm'] * 10.0
    xyz_path = stage_dir / 'h3-initial.xyz'
    xyz_path.write_text(
        f'3\nH3 exchange system  H_A({a_ang:.3f},0,0)  H_B({b_ang:.3f},0,0)  H_C({c_ang:.3f},0,0)  [Angstrom]\n'
        f'H  {a_ang:.6f}  0.000000  0.000000\n'
        f'H  {b_ang:.6f}  0.000000  0.000000\n'
        f'H  {c_ang:.6f}  0.000000  0.000000\n',
        encoding='utf-8'
    )

    # Compute initial potential energy
    probe_integrator = openmm.VerletIntegrator(H3_TIMESTEP_FS * unit.femtoseconds)
    probe_sim = create_simulation(topology, system, probe_integrator)
    probe_sim.context.setPositions(positions)
    initial_pe = probe_sim.context.getState(getEnergy=True).getPotentialEnergy().value_in_unit(
        unit.kilojoule_per_mole
    )
    log_message('info', f'H₃ topology built. Initial potential energy: {initial_pe:.3f} kJ/mol.')
    log_message('info',
        f'Reactive params: mass={params["mass_amu"]:.5f} amu, De={params["De_kj_mol"]:.3f} kJ/mol, '
        f're={params["re_nm"]:.4f} nm, alpha={params["alpha_inv_nm"]:.3f} nm^-1, '
        f'r_sw={params["rsw_nm"]:.4f} nm, w_sw={params["wsw_nm"]:.4f} nm, '
        f'A_rep={params["Arep_kj_mol"]:.3f} kJ/mol, b_rep={params["brep_inv_nm"]:.3f} nm^-1.'
    )

    checkpoint = {
        'label': 'Reactive H₃ system topology ready',
        'summary': (
            'Built the 3-atom H₃ system with Morse + bond-switching + '
            'A–C repulsion potential for reactive MD testing.'
        ),
        'generatedAt': iso_now(),
        'systemType': 'reactive-h3',
        'preparedStructurePath': to_relative_path(initial_pdb_path, root_dir),
        'systemXmlPath': to_relative_path(system_xml_path, root_dir),
        'xyzPath': to_relative_path(xyz_path, root_dir),
        'atomCount': 3,
        'initialPotentialEnergyKJPerMol': round(initial_pe, 4),
        'potentialFormula': 'Morse+switching (H_AB, H_BC) + exp repulsion (H_AC)',
    }
    checkpoint_path = stage_dir / 'protein-prep-checkpoint.json'
    write_json(checkpoint_path, checkpoint)
    return {
        'summary': 'Reactive H₃ system topology prepared with custom Morse + switching potential.',
        'checkpoint': checkpoint,
        'artifactPaths': [
            to_relative_path(initial_pdb_path, root_dir),
            to_relative_path(system_xml_path, root_dir),
            to_relative_path(xyz_path, root_dir),
            to_relative_path(checkpoint_path, root_dir),
        ],
    }


def _load_reactive_h3_simulation(payload: dict, integrator) -> tuple:
    """Load the H₃ system (topology + custom system) and return (simulation, pdb_file).

    The topology is always taken from the protein-prep checkpoint PDB;
    the system is always deserialized from the protein-prep system XML.
    """
    topo_checkpoint = require_stage_checkpoint(payload, 'protein-prep')
    system_xml_path = resolve_artifact_path(payload, topo_checkpoint['systemXmlPath'])
    pdb_path = resolve_artifact_path(payload, topo_checkpoint['preparedStructurePath'])
    system = XmlSerializer.deserialize(system_xml_path.read_text(encoding='utf-8'))
    pdb_file = PDBFile(str(pdb_path))
    simulation = create_simulation(pdb_file.topology, system, integrator)
    return simulation, pdb_file


def run_reactive_md_minimization(payload: dict) -> dict:
    """minimization handler for reactive-md-test: energy-minimise the H₃ system."""
    stage_context = get_stage_context(payload)
    stage_dir = stage_context['stage_dir']
    root_dir = stage_context['root_dir']
    config = get_stage_config(payload, 'minimization')

    integrator = openmm.LangevinMiddleIntegrator(
        300 * unit.kelvin, 1.0 / unit.picosecond,
        H3_TIMESTEP_FS * unit.femtoseconds
    )
    simulation, pdb_file = _load_reactive_h3_simulation(payload, integrator)
    simulation.context.setPositions(pdb_file.positions)

    pe_before = simulation.context.getState(getEnergy=True).getPotentialEnergy().value_in_unit(
        unit.kilojoule_per_mole
    )
    simulation.minimizeEnergy(
        tolerance=float(config.get('tolerance', 10)) * unit.kilojoule_per_mole / unit.nanometer,
        maxIterations=int(float(config.get('maxIterations', 500)))
    )
    state_after = simulation.context.getState(getPositions=True, getEnergy=True)
    minimized_positions = state_after.getPositions()
    pe_after = state_after.getPotentialEnergy().value_in_unit(unit.kilojoule_per_mole)

    minimized_pdb_path = stage_dir / 'h3-minimized.pdb'
    with minimized_pdb_path.open('w', encoding='utf-8') as handle:
        PDBFile.writeFile(pdb_file.topology, minimized_positions, handle)

    system_xml_out = stage_dir / 'minimization-system.xml'
    system_xml_out.write_text(
        XmlSerializer.serialize(XmlSerializer.deserialize(
            resolve_artifact_path(payload, require_stage_checkpoint(payload, 'protein-prep')['systemXmlPath'])
            .read_text(encoding='utf-8')
        )),
        encoding='utf-8'
    )
    checkpoint_bin = stage_dir / 'minimization.chk'
    simulation.saveCheckpoint(str(checkpoint_bin))

    log_message('info', f'H₃ minimization: PE {pe_before:.3f} → {pe_after:.3f} kJ/mol.')
    checkpoint = {
        'label': 'H₃ energy minimization complete',
        'summary': f'H₃ system minimized: PE {pe_before:.3f} → {pe_after:.3f} kJ/mol.',
        'generatedAt': iso_now(),
        'minimizedStructurePath': to_relative_path(minimized_pdb_path, root_dir),
        'systemXmlPath': to_relative_path(system_xml_out, root_dir),
        'openmmCheckpointPath': to_relative_path(checkpoint_bin, root_dir),
        'potentialEnergyBeforeKJPerMol': round(pe_before, 4),
        'potentialEnergyKJPerMol': round(pe_after, 4),
    }
    checkpoint_path = stage_dir / 'minimization-checkpoint.json'
    write_json(checkpoint_path, checkpoint)
    return {
        'summary': 'H₃ energy minimization complete.',
        'checkpoint': checkpoint,
        'artifactPaths': [
            to_relative_path(minimized_pdb_path, root_dir),
            to_relative_path(system_xml_out, root_dir),
            to_relative_path(checkpoint_bin, root_dir),
            to_relative_path(checkpoint_path, root_dir),
        ],
    }


def run_reactive_md_stage(payload: dict, stage_id: str) -> dict:
    """nvt / npt / production handler for reactive-md-test.

    Stage mapping
    ─────────────
    nvt        Langevin warmup at 600 K; positions from minimization checkpoint.
    npt        Gas-phase NVE pre-production (Verlet, no barostat); positions from NVT final PDB.
    production NVE production with directed H_A velocity; reaction coordinate tracked every frame.
    """
    stage_context = get_stage_context(payload)
    stage_dir = stage_context['stage_dir']
    root_dir = stage_context['root_dir']
    config = get_stage_config(payload, stage_id)

    # ── Integrator and duration ───────────────────────────────────────────────
    if stage_id == 'nvt':
        temperature_k = float(config.get('temperatureK', 600.0))
        timestep_fs = H3_TIMESTEP_FS
        duration_ps = float(config.get('durationPs', 10.0))
        total_steps = compute_step_count(duration_ps, 'ps', timestep_fs)
        integrator = openmm.LangevinMiddleIntegrator(
            temperature_k * unit.kelvin, 1.0 / unit.picosecond,
            timestep_fs * unit.femtoseconds
        )
        stage_label = 'NVT warmup (reactive H₃)'
        pos_stage_id = 'minimization'
        pos_key = 'minimizedStructurePath'
    elif stage_id == 'npt':
        temperature_k = 600.0
        timestep_fs = H3_TIMESTEP_FS
        duration_ps = float(config.get('durationPs', 50.0))
        total_steps = compute_step_count(duration_ps, 'ps', timestep_fs)
        integrator = openmm.VerletIntegrator(timestep_fs * unit.femtoseconds)
        stage_label = 'Gas-phase pre-production (reactive H₃)'
        pos_stage_id = 'nvt'
        pos_key = 'finalStructurePath'
    else:  # production
        temperature_k = 600.0
        timestep_fs = float(config.get('timeStepFs', H3_TIMESTEP_FS))
        duration_ns = float(config.get('durationNs', 0.05))
        total_steps = compute_step_count(duration_ns, 'ns', timestep_fs)
        integrator = openmm.VerletIntegrator(timestep_fs * unit.femtoseconds)
        stage_label = 'NVE production (reactive H₃)'
        pos_stage_id = 'npt'
        pos_key = 'finalStructurePath'

    # ── Set up simulation ─────────────────────────────────────────────────────
    simulation, initial_pdb = _load_reactive_h3_simulation(payload, integrator)

    prev_checkpoint = require_stage_checkpoint(payload, pos_stage_id)
    pos_pdb_path = resolve_artifact_path(payload, prev_checkpoint[pos_key])
    pos_pdb = PDBFile(str(pos_pdb_path))
    simulation.context.setPositions(pos_pdb.positions)

    if stage_id == 'production':
        # Directed initial velocity: H_A toward H_B, H_B and H_C stationary
        production_config = get_stage_config(payload, 'production')
        vx_a = float(production_config.get('reactiveVxAnmPerPs', H3_VA_PROD_NM_PS))
        velocities_nm_ps = [
            openmm.Vec3(vx_a, 0.0, 0.0),               # H_A
            openmm.Vec3(0.0, 0.0, 0.0),                 # H_B
            openmm.Vec3(0.0, 0.0, 0.0),                 # H_C
        ]
        simulation.context.setVelocities(
            unit.Quantity(velocities_nm_ps, unit.nanometer / unit.picosecond)
        )
        log_message('info', f'Set H_A initial velocity: {vx_a} nm/ps (directed toward H_B).')
    else:
        simulation.context.setVelocitiesToTemperature(temperature_k * unit.kelvin)

    # ── Reporters and output paths ────────────────────────────────────────────
    trajectory_path = stage_dir / f'{stage_id}.dcd'
    csv_path = stage_dir / f'{stage_id}-state.csv'
    final_pdb_path = stage_dir / f'{stage_id}-final.pdb'
    checkpoint_bin_path = stage_dir / f'{stage_id}.chk'

    write_interval_ps = float(config.get('writeIntervalPs', 0.1)) if stage_id == 'production' else 1.0
    report_steps = max(1, compute_step_count(write_interval_ps, 'ps', timestep_fs))

    simulation.reporters.append(DCDReporter(str(trajectory_path), report_steps))
    simulation.reporters.append(StateDataReporter(
        str(csv_path), report_steps,
        step=True, time=True,
        potentialEnergy=True, kineticEnergy=True, totalEnergy=True,
        temperature=True, progress=True, remainingTime=True, speed=True,
        totalSteps=total_steps, separator=','
    ))

    log_message('info', f'Running {stage_label}: {total_steps} steps on {get_platform_name()}.')

    # ── Run ───────────────────────────────────────────────────────────────────
    if stage_id == 'production':
        # Step in report-sized chunks; track reaction coordinate after each chunk
        rc_csv_path = stage_dir / 'reaction-coordinate.csv'
        with rc_csv_path.open('w', encoding='utf-8') as rc_file:
            rc_file.write('step,time_ps,r_AB_nm,r_BC_nm,xi_nm,pe_kJ_mol,ke_kJ_mol,total_e_kJ_mol\n')
            steps_done = 0
            while steps_done < total_steps:
                chunk = min(report_steps, total_steps - steps_done)
                simulation.step(chunk)
                steps_done += chunk
                state = simulation.context.getState(getPositions=True, getEnergy=True)
                pos_nm = state.getPositions().value_in_unit(unit.nanometer)
                pe = state.getPotentialEnergy().value_in_unit(unit.kilojoule_per_mole)
                ke = state.getKineticEnergy().value_in_unit(unit.kilojoule_per_mole)
                # Reaction coordinate: all atoms lie along x-axis
                xa, xb, xc = pos_nm[0][0], pos_nm[1][0], pos_nm[2][0]
                r_ab = abs(xb - xa)
                r_bc = abs(xc - xb)
                xi = r_ab - r_bc
                time_ps = steps_done * timestep_fs / 1000.0
                rc_file.write(
                    f'{steps_done},{time_ps:.6f},{r_ab:.6f},{r_bc:.6f},'
                    f'{xi:.6f},{pe:.4f},{ke:.4f},{pe + ke:.4f}\n'
                )
    else:
        simulation.step(total_steps)

    simulation.saveCheckpoint(str(checkpoint_bin_path))
    final_state = simulation.context.getState(getPositions=True, getEnergy=True)
    with final_pdb_path.open('w', encoding='utf-8') as handle:
        PDBFile.writeFile(initial_pdb.topology, final_state.getPositions(), handle)

    final_pe = final_state.getPotentialEnergy().value_in_unit(unit.kilojoule_per_mole)
    log_message('info', f'{stage_label} complete. Final PE: {final_pe:.3f} kJ/mol.')

    checkpoint = {
        'label': f'{stage_label} complete',
        'summary': f'Completed {stage_label.lower()} ({total_steps} steps).',
        'generatedAt': iso_now(),
        'finalStructurePath': to_relative_path(final_pdb_path, root_dir),
        'trajectoryPath': to_relative_path(trajectory_path, root_dir),
        'stateCsvPath': to_relative_path(csv_path, root_dir),
        'openmmCheckpointPath': to_relative_path(checkpoint_bin_path, root_dir),
        'potentialEnergyKJPerMol': round(final_pe, 4),
        'totalSteps': total_steps,
        'timestepFs': timestep_fs,
        'temperatureK': temperature_k,
        'platform': get_platform_name(),
    }
    artifact_paths = [
        to_relative_path(trajectory_path, root_dir),
        to_relative_path(csv_path, root_dir),
        to_relative_path(final_pdb_path, root_dir),
        to_relative_path(checkpoint_bin_path, root_dir),
    ]
    if stage_id == 'production':
        checkpoint['reactionCoordinateCsvPath'] = to_relative_path(rc_csv_path, root_dir)
        artifact_paths.append(to_relative_path(rc_csv_path, root_dir))

    checkpoint_path = stage_dir / f'{stage_id}-checkpoint.json'
    write_json(checkpoint_path, checkpoint)
    artifact_paths.append(to_relative_path(checkpoint_path, root_dir))

    return {
        'summary': f'{stage_label} completed.',
        'checkpoint': checkpoint,
        'artifactPaths': artifact_paths,
    }


# ─── End reactive MD implementation ──────────────────────────────────────────


def run_md_stage(payload: dict, stage_id: str, previous_stage_id: str, stage_label: str,
                 duration_unit: str, add_barostat: bool) -> dict:
    stage_context = get_stage_context(payload)
    stage_dir = stage_context['stage_dir']
    previous_checkpoint = require_stage_checkpoint(payload, previous_stage_id)

    if stage_id == 'nvt':
        structure_key = 'minimizedStructurePath'
        force_field_name = previous_checkpoint.get('resolvedForceField')
    else:
        structure_key = 'finalStructurePath'
        force_field_name = previous_checkpoint.get('resolvedForceField')

    input_structure_path = resolve_artifact_path(payload, previous_checkpoint[structure_key])
    pdb_file = PDBFile(str(input_structure_path))
    protein_force_field = get_stage_config(payload, 'protein-prep').get('forceField', 'amber14')
    water_model = (require_stage_checkpoint(payload, 'ions')).get('waterModel', 'tip3p')
    forcefield, resolved_force_field = build_force_field(force_field_name or protein_force_field, water_model, payload)
    system = create_system(forcefield, pdb_file.topology)

    config = get_stage_config(payload, stage_id)
    if stage_id == 'nvt' and bool(config.get('heavyAtomRestraints', True)):
        apply_position_restraints(system, pdb_file.topology, pdb_file.positions, 'protein-heavy')
    if stage_id == 'npt' and not bool(config.get('releaseRestraints', True)):
        apply_position_restraints(system, pdb_file.topology, pdb_file.positions, 'protein-heavy')
    if add_barostat:
        pressure_bar = float(config.get('pressureBar', 1.0)) if stage_id == 'npt' else 1.0
        system.addForce(MonteCarloBarostat(pressure_bar * unit.bar, 300 * unit.kelvin))

    temperature_k = float(config.get('temperatureK', 300.0))
    timestep_fs = float(config.get('timeStepFs', 2.0)) if stage_id == 'production' else 2.0
    duration_value = float(config.get('durationPs', 25.0)) if duration_unit == 'ps' else float(config.get('durationNs', 0.1))
    total_steps = compute_step_count(duration_value, duration_unit, timestep_fs)
    if total_steps > MAX_SIMULATION_STEPS:
        raise ValueError(
            f'{stage_label} requested {total_steps} steps, which exceeds the current local safety cap of {MAX_SIMULATION_STEPS} steps. Reduce the duration before running this stage.'
        )

    write_interval_ps = float(config.get('writeIntervalPs', 1.0)) if stage_id == 'production' else 1.0
    report_interval_steps = max(1, compute_step_count(write_interval_ps, 'ps', timestep_fs))
    integrator = openmm.LangevinMiddleIntegrator(temperature_k * unit.kelvin, 1.0 / unit.picosecond, timestep_fs * unit.femtoseconds)
    simulation = create_simulation(pdb_file.topology, system, integrator)
    loaded_from_checkpoint = False
    if stage_id == 'production' and previous_checkpoint.get('openmmCheckpointPath'):
        checkpoint_binary_path = resolve_artifact_path(payload, previous_checkpoint.get('openmmCheckpointPath', ''))
        if checkpoint_binary_path.exists():
            try:
                simulation.loadCheckpoint(str(checkpoint_binary_path))
                simulation.currentStep = 0
                loaded_from_checkpoint = True
                log_message('info', 'Loaded the previous NPT OpenMM checkpoint to continue into production.')
            except Exception as error:
                log_message('warn', f'Unable to load the previous OpenMM checkpoint for production continuity: {error}. Falling back to coordinates only.')

    if not loaded_from_checkpoint:
        simulation.context.setPositions(pdb_file.positions)
        simulation.context.setVelocitiesToTemperature(temperature_k * unit.kelvin)

    trajectory_path = stage_dir / f'{stage_id}.dcd'
    csv_path = stage_dir / f'{stage_id}-state.csv'
    final_structure_path = stage_dir / f'{stage_id}-final.pdb'
    binary_checkpoint_path = stage_dir / f'{stage_id}.chk'
    summary_path = stage_dir / f'{stage_id}-summary.json'

    simulation.reporters.append(DCDReporter(str(trajectory_path), report_interval_steps))
    simulation.reporters.append(StateDataReporter(
        str(csv_path),
        report_interval_steps,
        step=True,
        time=True,
        potentialEnergy=True,
        kineticEnergy=True,
        totalEnergy=True,
        temperature=True,
        density=add_barostat,
        progress=True,
        remainingTime=True,
        speed=True,
        totalSteps=total_steps,
        separator=','
    ))

    log_message('info', f'Running {stage_label} for {total_steps} integration steps on the {get_platform_name()} platform.')
    simulation.step(total_steps)
    simulation.saveCheckpoint(str(binary_checkpoint_path))
    state = simulation.context.getState(getPositions=True, getEnergy=True)
    with final_structure_path.open('w', encoding='utf-8') as handle:
        PDBFile.writeFile(pdb_file.topology, state.getPositions(), handle, keepIds=True)

    summary = {
        'generatedAt': iso_now(),
        'resolvedForceField': resolved_force_field,
        'temperatureK': temperature_k,
        'timestepFs': timestep_fs,
        'durationValue': duration_value,
        'durationUnit': duration_unit,
        'totalSteps': total_steps,
        'platform': get_platform_name(),
        'potentialEnergyKJPerMol': state.getPotentialEnergy().value_in_unit(unit.kilojoule_per_mole)
    }
    write_json(summary_path, summary)

    checkpoint = {
        'label': f'{stage_label} complete',
        'summary': f"Completed {stage_label.lower()} with {total_steps} steps and trajectory output.",
        'generatedAt': iso_now(),
        'finalStructurePath': to_relative_path(final_structure_path, stage_context['root_dir']),
        'trajectoryPath': to_relative_path(trajectory_path, stage_context['root_dir']),
        'stateCsvPath': to_relative_path(csv_path, stage_context['root_dir']),
        'openmmCheckpointPath': to_relative_path(binary_checkpoint_path, stage_context['root_dir']),
        'summaryPath': to_relative_path(summary_path, stage_context['root_dir']),
        'resolvedForceField': resolved_force_field,
        'temperatureK': temperature_k,
        'totalSteps': total_steps,
        'durationValue': duration_value,
        'durationUnit': duration_unit,
        'timestepFs': timestep_fs,
        'platform': get_platform_name()
    }
    checkpoint_path = stage_dir / f'{stage_id}-checkpoint.json'
    write_json(checkpoint_path, checkpoint)
    log_message('info', f"{stage_label} finished and wrote {trajectory_path.name}.")

    return {
        'summary': f'{stage_label} completed with a trajectory segment.',
        'checkpoint': checkpoint,
        'artifactPaths': [
            to_relative_path(trajectory_path, stage_context['root_dir']),
            to_relative_path(csv_path, stage_context['root_dir']),
            to_relative_path(final_structure_path, stage_context['root_dir']),
            to_relative_path(binary_checkpoint_path, stage_context['root_dir']),
            to_relative_path(summary_path, stage_context['root_dir']),
            to_relative_path(checkpoint_path, stage_context['root_dir'])
        ]
    }


def get_stage_context(payload: dict) -> dict:
    root_dir = Path(payload['rootDir'])
    project_dir = Path(payload['projectDir'])
    stage_dir = Path(payload['stageDir'])
    job_dir = Path(payload['jobDir'])
    stage_dir.mkdir(parents=True, exist_ok=True)
    job_dir.mkdir(parents=True, exist_ok=True)
    return {
        'root_dir': root_dir,
        'project_dir': project_dir,
        'stage_dir': stage_dir,
        'job_dir': job_dir
    }


def get_stage_config(payload: dict, stage_id: str) -> dict:
    stage_data = payload.get('stageData') or {}
    stage_entry = stage_data.get(stage_id) or {}
    if isinstance(stage_entry, dict) and 'config' in stage_entry:
        return stage_entry.get('config') or {}
    return stage_entry if isinstance(stage_entry, dict) else {}


def require_stage_checkpoint(payload: dict, stage_id: str) -> dict:
    checkpoint = (payload.get('stageCheckpoints') or {}).get(stage_id)
    if not checkpoint:
        raise ValueError(f'Stage {stage_id} must complete before this stage can run.')
    return checkpoint


def resolve_structure_for_system_build(payload: dict) -> Path:
    workflow_type = payload.get('workflowType', 'protein-water')
    if workflow_type == 'protein-ligand-water':
        complex_checkpoint = require_stage_checkpoint(payload, 'complex-build')
        complex_path = complex_checkpoint.get('complexPdbPath')
        if complex_path:
            return resolve_artifact_path(payload, complex_path)

    protein_checkpoint = require_stage_checkpoint(payload, 'protein-prep')
    return resolve_artifact_path(payload, protein_checkpoint['preparedStructurePath'])


def resolve_artifact_path(payload: dict, artifact_path: str) -> Path:
    if not artifact_path:
        raise ValueError('A required stage artifact path is missing.')
    return Path(payload['rootDir']) / artifact_path


def resolve_workspace_file_path(payload: dict, file_path: str) -> Path:
    normalized_path = str(file_path or '').strip()
    if not normalized_path:
        raise ValueError('A workspace file path is required for imported pose geometry.')
    candidate = Path(normalized_path)

    root_dir = Path(payload['rootDir']).resolve()
    project_dir = Path(payload['projectDir']).resolve()
    search_paths = [candidate] if candidate.is_absolute() else [root_dir / candidate, project_dir / candidate]

    for search_path in search_paths:
        resolved_path = search_path.resolve()
        if not resolved_path.exists() or not resolved_path.is_file():
            continue
        try:
            resolved_path.relative_to(root_dir)
        except ValueError:
            continue
        return resolved_path

    raise ValueError('Imported pose files must exist inside the workspace and be referenced by a workspace-relative path.')


def resolve_structure_source(payload: dict) -> dict:
    selected = payload.get('selectedMolecules') or []
    for item in selected:
        database = str(item.get('database', '')).lower()
        if 'protein data bank' in database or ('pdb' in database and 'alphafold' not in database):
            identifier = extract_pdb_identifier(item)
            return {
                'source_type': 'pdb',
                'identifier': identifier,
                'url': f'https://files.rcsb.org/download/{identifier}.pdb'
            }
    for item in selected:
        database = str(item.get('database', '')).lower()
        if 'alphafold' in database:
            accession = extract_uniprot_accession(item)
            pdb_url = fetch_alphafold_pdb_url(accession)
            return {
                'source_type': 'alphafold',
                'identifier': accession,
                'url': pdb_url
            }
    for item in selected:
        database = str(item.get('database', '')).lower()
        if 'uniprot' in database:
            accession = extract_uniprot_accession(item)
            pdb_url = fetch_alphafold_pdb_url(accession)
            return {
                'source_type': 'alphafold-from-uniprot',
                'identifier': accession,
                'url': pdb_url
            }
    raise ValueError('Protein preparation requires a PDB, AlphaFold, or UniProt structure source.')


def resolve_ligand_item(payload: dict) -> dict | None:
    selected = payload.get('selectedMolecules') or []
    for item in selected:
        database = str(item.get('database', '')).lower()
        if 'pubchem' in database or 'chembl' in database:
            return item
    return None


def resolve_ligand_smiles(item: dict) -> str:
    data = item.get('data') or {}
    candidate_values = [
        data.get('CanonicalSMILES'),
        data.get('IsomericSMILES'),
        data.get('canonical_smiles'),
        ((data.get('molecule_structures') or {}).get('canonical_smiles') if isinstance(data.get('molecule_structures'), dict) else None),
        ((data.get('molecule_structures') or {}).get('standard_inchi') if isinstance(data.get('molecule_structures'), dict) else None),
        data.get('smiles')
    ]
    for value in candidate_values:
        if value:
            return str(value)

    database = str(item.get('database', '')).lower()
    if 'pubchem' in database:
        cid = data.get('cid') or extract_numeric_suffix(item.get('id', ''))
        if cid:
            url = f'https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid/{cid}/property/CanonicalSMILES/JSON'
            response = read_json_url(url)
            properties = (((response.get('PropertyTable') or {}).get('Properties')) or [])
            if properties:
                smiles = properties[0].get('CanonicalSMILES')
                if smiles:
                    return smiles
    if 'chembl' in database:
        chembl_id = (data.get('molecule_chembl_id') or extract_chembl_identifier(item.get('id', '')) or '').upper()
        if chembl_id:
            url = f'https://www.ebi.ac.uk/chembl/api/data/molecule/{chembl_id}.json'
            response = read_json_url(url)
            smiles = ((response.get('molecule_structures') or {}).get('canonical_smiles'))
            if smiles:
                return smiles

    return ''


def require_openff_ligand_stack():
    try:
        from openff.toolkit import Molecule
        from openmmforcefields.generators import SMIRNOFFTemplateGenerator
    except Exception as error:
        raise ValueError(
            'OpenFF ligand parameterization dependencies are not available in this backend runtime. '
            'Install `requirements-md.txt` for development or rebuild the packaged backend runtime before using protein-ligand MD stages.'
        ) from error
    return Molecule, SMIRNOFFTemplateGenerator


def parameterize_ligand_openff(molecule, ligand_item: dict, stage_dir: Path) -> dict:
    Molecule, SMIRNOFFTemplateGenerator = require_openff_ligand_stack()
    off_molecule = Molecule.from_rdkit(molecule, allow_undefined_stereo=True, hydrogens_are_explicit=True)
    off_molecule.name = ligand_item.get('title', 'Ligand')

    charge_method = 'mmff94'
    try:
        off_molecule.assign_partial_charges(charge_method)
    except Exception:
        charge_method = 'gasteiger'
        off_molecule.assign_partial_charges(charge_method)

    smirnoff_force_field = 'openff-2.2.1'
    template_generator = SMIRNOFFTemplateGenerator(molecules=off_molecule, forcefield=smirnoff_force_field)
    template_contents = template_generator.generate_residue_template(off_molecule)

    template_path = stage_dir / 'ligand-smirnoff-template.ffxml'
    template_path.write_text(template_contents, encoding='utf-8')
    openff_json_path = stage_dir / 'ligand-openff.json'
    openff_json_path.write_text(off_molecule.to_json(), encoding='utf-8')

    return {
        'forcefield': smirnoff_force_field,
        'chargeMethod': charge_method,
        'note': f'Parameterized the ligand with {smirnoff_force_field} using RDKit {charge_method.upper()} partial charges.',
        'templatePath': template_path,
        'openffJsonPath': openff_json_path
    }


def load_parameterized_ligand(payload: dict, ligand_checkpoint: dict):
    Molecule, _ = require_openff_ligand_stack()
    openff_json_path = ligand_checkpoint.get('openffJsonPath')
    if openff_json_path:
        return Molecule.from_json(resolve_artifact_path(payload, openff_json_path).read_text(encoding='utf-8'))

    ligand_sdf_path = resolve_artifact_path(payload, ligand_checkpoint['ligandSdfPath'])
    supplier = Chem.SDMolSupplier(str(ligand_sdf_path), removeHs=False)
    molecule = next((item for item in supplier if item is not None), None)
    if molecule is None:
        raise ValueError('Unable to reload the ligand SDF needed for system parameterization.')

    off_molecule = Molecule.from_rdkit(molecule, allow_undefined_stereo=True, hydrogens_are_explicit=True)
    charge_method = ligand_checkpoint.get('chargeMethod') or 'mmff94'
    off_molecule.assign_partial_charges(charge_method)
    return off_molecule


def materialize_imported_ligand_pose(payload: dict, ligand_checkpoint: dict, pose_import_path: str, stage_dir: Path,
                                     selected_reference_residue_id: str = '') -> tuple[Path, dict, list[str]]:
    root_dir = Path(payload['rootDir'])
    source_pose_path = resolve_workspace_file_path(payload, pose_import_path)
    prepared_ligand_sdf_path = resolve_artifact_path(payload, ligand_checkpoint['ligandSdfPath'])

    copied_pose_path = stage_dir / f'imported-pose{source_pose_path.suffix.lower() or ".dat"}'
    if source_pose_path.resolve() != copied_pose_path.resolve():
        shutil.copyfile(source_pose_path, copied_pose_path)

    alignment_pose_path, source_pose_report, extracted_artifact_paths = prepare_pose_source_for_alignment(
        prepared_ligand_sdf_path,
        source_pose_path,
        stage_dir,
        root_dir,
        selected_reference_residue_id
    )
    aligned_ligand, alignment_report = align_prepared_ligand_to_pose(prepared_ligand_sdf_path, alignment_pose_path)

    aligned_sdf_path = stage_dir / 'ligand-pose-aligned.sdf'
    aligned_pdb_path = stage_dir / 'ligand-pose-aligned.pdb'
    writer = Chem.SDWriter(str(aligned_sdf_path))
    writer.write(aligned_ligand)
    writer.close()
    Chem.MolToPDBFile(aligned_ligand, str(aligned_pdb_path))

    return aligned_pdb_path, {
        'mode': 'imported-pose-alignment',
        'sourcePath': to_relative_path(source_pose_path, root_dir),
        'sourceArtifactPath': to_relative_path(copied_pose_path, root_dir),
        'alignedLigandPdbPath': to_relative_path(aligned_pdb_path, root_dir),
        'alignedLigandSdfPath': to_relative_path(aligned_sdf_path, root_dir),
        **source_pose_report,
        **alignment_report
    }, [
        to_relative_path(copied_pose_path, root_dir),
        *extracted_artifact_paths,
        to_relative_path(aligned_sdf_path, root_dir),
        to_relative_path(aligned_pdb_path, root_dir)
    ]


def prepare_pose_source_for_alignment(prepared_ligand_sdf_path: Path, source_pose_path: Path, stage_dir: Path, root_dir: Path,
                                      selected_reference_residue_id: str = '') -> tuple[Path, dict, list[str]]:
    if source_pose_path.suffix.lower() != '.pdb':
        return source_pose_path, {
            'sourceType': 'ligand-pose-file'
        }, []

    residue_candidates, has_polymer_records = collect_reference_pose_candidates(source_pose_path)
    if not residue_candidates or (len(residue_candidates) == 1 and not has_polymer_records):
        return source_pose_path, {
            'sourceType': 'ligand-only-pdb'
        }, []

    extracted_pose_path, extraction_report = extract_ligand_from_reference_complex_pdb(
        prepared_ligand_sdf_path,
        residue_candidates,
        stage_dir,
        root_dir,
        selected_reference_residue_id
    )
    return extracted_pose_path, extraction_report, [to_relative_path(extracted_pose_path, root_dir)]


def collect_reference_pose_candidates(source_pose_path: Path) -> tuple[list[dict], bool]:
    pdb_lines = source_pose_path.read_text(encoding='utf-8', errors='ignore').splitlines()
    has_polymer_records = any(line.startswith('ATOM  ') for line in pdb_lines)
    residue_groups: dict[tuple[str, str, str, str], dict] = {}
    conect_lines: list[str] = []

    for raw_line in pdb_lines:
        line = raw_line.rstrip('\n')
        record_name = line[0:6].strip().upper()
        if record_name == 'HETATM':
            residue_name = line[17:20].strip().upper() or 'UNK'
            chain_id = line[21].strip()
            residue_number = line[22:26].strip()
            insertion_code = line[26].strip()
            atom_serial = parse_pdb_atom_serial(line)
            residue_key = (residue_name, chain_id, residue_number, insertion_code)
            residue_group = residue_groups.setdefault(residue_key, {
                'residueName': residue_name,
                'chainId': chain_id,
                'residueNumber': residue_number,
                'insertionCode': insertion_code,
                'lines': [],
                'atomSerials': set()
            })
            residue_group['lines'].append(line)
            if atom_serial is not None:
                residue_group['atomSerials'].add(atom_serial)
        elif record_name == 'CONECT':
            conect_lines.append(line)

    candidates = []
    for residue_group in residue_groups.values():
        heavy_atom_count = count_pdb_heavy_atoms(residue_group['lines'])
        if heavy_atom_count < 3 or residue_group['residueName'] in EXCLUDED_REFERENCE_POSE_RESIDUES:
            continue

        residue_conect_lines = [
            line for line in conect_lines
            if pdb_conect_line_within_residue(line, residue_group['atomSerials'])
        ]
        residue_block = '\n'.join([
            *residue_group['lines'],
            'TER',
            *residue_conect_lines,
            'END'
        ]) + '\n'
        residue_molecule = Chem.MolFromPDBBlock(residue_block, removeHs=False)
        if residue_molecule is None or residue_molecule.GetNumConformers() == 0:
            continue

        candidates.append({
            **residue_group,
            'heavyAtomCount': heavy_atom_count,
            'pdbBlock': residue_block,
            'molecule': residue_molecule
        })

    return candidates, has_polymer_records


def extract_ligand_from_reference_complex_pdb(prepared_ligand_sdf_path: Path, residue_candidates: list[dict], stage_dir: Path,
                                              root_dir: Path, selected_reference_residue_id: str = '') -> tuple[Path, dict]:
    prepared_ligand = load_ligand_pose_molecule(prepared_ligand_sdf_path)
    best_candidate = None
    best_report = None
    best_score = None

    if selected_reference_residue_id:
        matching_candidate = next(
            (candidate for candidate in residue_candidates if format_pose_residue_id(candidate) == selected_reference_residue_id),
            None
        )
        if matching_candidate is None:
            raise ValueError(
                f'Reference residue {selected_reference_residue_id} was not found in the uploaded reference-complex PDB.'
            )
        try:
            _, best_report = align_ligand_molecules(prepared_ligand, matching_candidate['molecule'])
        except Exception as error:
            raise ValueError(
                f'Reference residue {selected_reference_residue_id} does not match the prepared ligand well enough to reuse its parameterization.'
            ) from error
        best_candidate = matching_candidate

    if best_candidate is None:
        for candidate in residue_candidates:
            try:
                _, alignment_report = align_ligand_molecules(prepared_ligand, candidate['molecule'])
            except Exception:
                continue

            candidate_score = (
                alignment_report['matchCoverage'],
                alignment_report['matchedHeavyAtoms'],
                -alignment_report['alignmentRmsdAngstrom']
            )
            if best_candidate is None or candidate_score > best_score:
                best_candidate = candidate
                best_report = alignment_report
                best_score = candidate_score

    if best_candidate is None or best_report is None:
        raise ValueError(
            'Unable to extract a ligand residue from the imported reference-complex PDB that matches the prepared ligand. '
            'Upload the docked ligand alone or a reference complex PDB containing the same ligand chemistry.'
        )

    extracted_pose_path = stage_dir / 'reference-complex-ligand-extracted.pdb'
    extracted_pose_path.write_text(best_candidate['pdbBlock'], encoding='utf-8')

    return extracted_pose_path, {
        'sourceType': 'reference-complex-pdb',
        'extractedLigandPath': to_relative_path(extracted_pose_path, root_dir),
        'candidateResidueCount': len(residue_candidates),
        'extractedResidueName': best_candidate['residueName'],
        'extractedResidueId': format_pose_residue_id(best_candidate),
        'extractedHeavyAtomCount': best_candidate['heavyAtomCount'],
        'extractionMatchCoverage': best_report['matchCoverage']
    }


def align_prepared_ligand_to_pose(prepared_ligand_sdf_path: Path, pose_path: Path):
    prepared_ligand = load_ligand_pose_molecule(prepared_ligand_sdf_path)
    pose_ligand = load_ligand_pose_molecule(pose_path)

    return align_ligand_molecules(prepared_ligand, pose_ligand)


def align_ligand_molecules(prepared_ligand, pose_ligand):

    prepared_heavy = Chem.RemoveHs(Chem.Mol(prepared_ligand))
    pose_heavy = Chem.RemoveHs(Chem.Mol(pose_ligand))
    atom_map, match_count = build_ligand_alignment_atom_map(prepared_heavy, pose_heavy)
    coverage = match_count / max(1, min(prepared_heavy.GetNumAtoms(), pose_heavy.GetNumAtoms()))
    if match_count < 3 or coverage < 0.8:
        raise ValueError(
            'The imported pose does not match the prepared ligand closely enough to reuse its parameterization. '
            'Use a docked/reference pose for the same ligand, either as a ligand-only pose file or a reference-complex PDB containing that ligand.'
        )

    aligned_ligand = Chem.Mol(prepared_ligand)
    alignment_rmsd = float(rdMolAlign.AlignMol(aligned_ligand, pose_ligand, atomMap=atom_map))
    return aligned_ligand, {
        'alignmentRmsdAngstrom': round(alignment_rmsd, 4),
        'matchedHeavyAtoms': match_count,
        'preparedHeavyAtomCount': prepared_heavy.GetNumAtoms(),
        'poseHeavyAtomCount': pose_heavy.GetNumAtoms(),
        'matchCoverage': round(coverage, 4)
    }


def build_ligand_alignment_atom_map(prepared_ligand, pose_ligand) -> tuple[list[tuple[int, int]], int]:
    mcs_result = rdFMCS.FindMCS(
        [prepared_ligand, pose_ligand],
        timeout=10,
        ringMatchesRingOnly=True,
        completeRingsOnly=False,
        atomCompare=rdFMCS.AtomCompare.CompareElements,
        bondCompare=rdFMCS.BondCompare.CompareAny
    )
    if not mcs_result.numAtoms or not mcs_result.smartsString:
        raise ValueError('Unable to identify a common ligand scaffold between the prepared ligand and the imported pose file.')

    query = Chem.MolFromSmarts(mcs_result.smartsString)
    if query is None:
        raise ValueError('Unable to construct a ligand alignment query for the imported pose file.')

    prepared_match = prepared_ligand.GetSubstructMatch(query)
    pose_match = pose_ligand.GetSubstructMatch(query)
    if not prepared_match or not pose_match:
        raise ValueError('Unable to map ligand atoms between the prepared ligand and the imported pose file.')

    return list(zip(prepared_match, pose_match)), int(mcs_result.numAtoms)


def load_ligand_pose_molecule(pose_path: Path):
    extension = pose_path.suffix.lower()
    if extension == '.sdf':
        supplier = Chem.SDMolSupplier(str(pose_path), removeHs=False)
        molecule = next((item for item in supplier if item is not None), None)
    elif extension == '.mol':
        molecule = Chem.MolFromMolFile(str(pose_path), removeHs=False)
    elif extension == '.mol2':
        molecule = Chem.MolFromMol2File(str(pose_path), removeHs=False)
    elif extension == '.pdb':
        molecule = Chem.MolFromPDBFile(str(pose_path), removeHs=False)
    else:
        raise ValueError('Imported pose files must use .sdf, .mol, .mol2, or .pdb formats.')

    if molecule is None:
        raise ValueError(f'Unable to read ligand coordinates from imported pose file {pose_path.name}.')
    if molecule.GetNumConformers() == 0:
        raise ValueError(f'Imported pose file {pose_path.name} does not contain 3D coordinates.')
    return molecule


def parse_pdb_atom_serial(line: str) -> int | None:
    serial_text = line[6:11].strip()
    return int(serial_text) if serial_text.isdigit() else None


def parse_pdb_conect_serials(line: str) -> list[int]:
    serials = []
    for start_index in range(6, len(line), 5):
        token = line[start_index:start_index + 5].strip()
        if token.isdigit():
            serials.append(int(token))
    return serials


def pdb_conect_line_within_residue(line: str, atom_serials: set[int]) -> bool:
    serials = parse_pdb_conect_serials(line)
    return bool(serials) and set(serials).issubset(atom_serials)


def count_pdb_heavy_atoms(atom_lines: list[str]) -> int:
    heavy_atom_count = 0
    for line in atom_lines:
        element_symbol = line[76:78].strip().upper() or line[12:16].strip()[0:1].upper()
        if element_symbol != 'H':
            heavy_atom_count += 1
    return heavy_atom_count


def format_pose_residue_id(candidate: dict) -> str:
    chain_prefix = f"{candidate['chainId']}:" if candidate.get('chainId') else ''
    insertion_suffix = candidate.get('insertionCode') or ''
    return f"{candidate['residueName']} {chain_prefix}{candidate['residueNumber']}{insertion_suffix}".strip()


def position_ligand_for_complex(protein_positions, ligand_positions, clearance_nm: float) -> tuple[unit.Quantity, dict]:
    protein_coordinates = positions_to_coordinate_rows(protein_positions)
    ligand_coordinates = positions_to_coordinate_rows(ligand_positions)
    protein_minimums, protein_maximums = compute_coordinate_bounds(protein_coordinates)
    ligand_minimums, ligand_maximums = compute_coordinate_bounds(ligand_coordinates)

    protein_center = [
        (protein_minimums[index] + protein_maximums[index]) / 2.0
        for index in range(3)
    ]
    ligand_center = [
        (ligand_minimums[index] + ligand_maximums[index]) / 2.0
        for index in range(3)
    ]
    ligand_half_span_x = (ligand_maximums[0] - ligand_minimums[0]) / 2.0

    target_center = [
        protein_maximums[0] + clearance_nm + ligand_half_span_x,
        protein_center[1],
        protein_center[2]
    ]
    translation = [
        target_center[index] - ligand_center[index]
        for index in range(3)
    ]

    translated_positions = unit.Quantity([
        openmm.Vec3(
            coordinate[0] + translation[0],
            coordinate[1] + translation[1],
            coordinate[2] + translation[2]
        )
        for coordinate in ligand_coordinates
    ], unit.nanometer)

    return translated_positions, {
        'translationVectorNm': [round(value, 4) for value in translation],
        'clearanceNm': clearance_nm,
        'proteinBoundsNm': {
            'min': [round(value, 4) for value in protein_minimums],
            'max': [round(value, 4) for value in protein_maximums]
        },
        'ligandBoundsNm': {
            'min': [round(value, 4) for value in ligand_minimums],
            'max': [round(value, 4) for value in ligand_maximums]
        }
    }


def positions_to_coordinate_rows(positions) -> list[list[float]]:
    coordinates = positions.value_in_unit(unit.nanometer)
    return [
        [float(coordinate[0]), float(coordinate[1]), float(coordinate[2])]
        for coordinate in coordinates
    ]


def compute_coordinate_bounds(coordinates: list[list[float]]) -> tuple[list[float], list[float]]:
    minimums = [min(point[index] for point in coordinates) for index in range(3)]
    maximums = [max(point[index] for point in coordinates) for index in range(3)]
    return minimums, maximums


def fetch_structure_file(structure_source: dict, output_path: Path) -> None:
    if output_path.exists():
        return

    request = urllib.request.Request(structure_source['url'], headers={'User-Agent': 'molecular-analysis/1.0'})
    with urllib.request.urlopen(request) as response:
        output_path.write_bytes(response.read())


def fetch_alphafold_pdb_url(accession: str) -> str:
    response = read_json_url(f'https://alphafold.ebi.ac.uk/api/prediction/{accession}')
    if not response:
        raise ValueError(f'No AlphaFold structure could be found for {accession}.')
    return response[0]['pdbUrl']


def read_json_url(url: str):
    request = urllib.request.Request(url, headers={'User-Agent': 'molecular-analysis/1.0'})
    with urllib.request.urlopen(request) as response:
        return json.loads(response.read().decode('utf-8'))


def build_force_field(force_field_name: str | None, water_model: str, payload: dict | None = None) -> tuple[ForceField, str]:
    normalized = normalize_force_field_name(force_field_name)
    protein_xml, water_map = PROTEIN_FORCE_FIELD_FILES[normalized]
    water_xml = water_map.get(water_model, next(iter(water_map.values())))
    forcefield = ForceField(protein_xml, water_xml)

    ligand_checkpoint = ((payload or {}).get('stageCheckpoints') or {}).get('ligand-prep') or {}
    if (payload or {}).get('workflowType') == 'protein-ligand-water' and ligand_checkpoint.get('parameterizationReady'):
        parameterized_ligand = load_parameterized_ligand(payload, ligand_checkpoint)
        _, SMIRNOFFTemplateGenerator = require_openff_ligand_stack()
        template_generator = SMIRNOFFTemplateGenerator(
            molecules=parameterized_ligand,
            forcefield=ligand_checkpoint.get('parameterizationForceField') or 'openff-2.2.1'
        )
        forcefield.registerTemplateGenerator(template_generator.generator)
        log_message('info', 'Registered a parameterized OpenFF ligand template for downstream system construction.')

    return forcefield, normalized


def normalize_force_field_name(force_field_name: str | None) -> str:
    if force_field_name in PROTEIN_FORCE_FIELD_FILES:
        return force_field_name
    return 'amber14'


def create_system(forcefield: ForceField, topology) -> openmm.System:
    return forcefield.createSystem(
        topology,
        nonbondedMethod=PME,
        nonbondedCutoff=1.0 * unit.nanometer,
        constraints=openmm.app.HBonds,
        rigidWater=True,
        ewaldErrorTolerance=0.0005
    )


def create_simulation(topology, system, integrator) -> Simulation:
    platform = get_platform()
    return Simulation(topology, system, integrator, platform)


def get_platform() -> openmm.Platform:
    for candidate in ('CPU', 'Reference'):
        try:
            return openmm.Platform.getPlatformByName(candidate)
        except Exception:
            continue
    return openmm.Platform.getPlatform(0)


def get_platform_name() -> str:
    return get_platform().getName()


def apply_position_restraints(system, topology, positions, mode: str) -> None:
    if mode == 'none':
        return

    force = openmm.CustomExternalForce('k*periodicdistance(x, y, z, x0, y0, z0)^2')
    force.addGlobalParameter('k', 1000.0 * unit.kilojoule_per_mole / unit.nanometer**2)
    force.addPerParticleParameter('x0')
    force.addPerParticleParameter('y0')
    force.addPerParticleParameter('z0')

    restrained_count = 0
    for atom_index, atom in enumerate(topology.atoms()):
        if should_restrain_atom(atom, mode):
            position = positions[atom_index]
            force.addParticle(atom_index, [position.x, position.y, position.z])
            restrained_count += 1

    if restrained_count:
        system.addForce(force)
        log_message('info', f'Applied positional restraints to {restrained_count} atoms using {mode} mode.')


def should_restrain_atom(atom, mode: str) -> bool:
    if atom.element is None:
        return False
    residue_name = atom.residue.name.upper()
    is_biopolymer = residue_name in STANDARD_PROTEIN_RESIDUES or residue_name in STANDARD_NUCLEIC_RESIDUES
    if not is_biopolymer:
        return False

    if mode == 'protein-heavy':
        return atom.element.symbol != 'H'
    if mode == 'backbone':
        return atom.name.upper() in BACKBONE_ATOM_NAMES
    return False


def compute_box_dimensions_nm(positions, padding_nm: float) -> list[float]:
    coordinates = positions.value_in_unit(unit.nanometer)
    xs = [position[0] for position in coordinates]
    ys = [position[1] for position in coordinates]
    zs = [position[2] for position in coordinates]
    padding = 2.0 * padding_nm
    return [
        round((max(xs) - min(xs)) + padding, 3),
        round((max(ys) - min(ys)) + padding, 3),
        round((max(zs) - min(zs)) + padding, 3)
    ]


def resolve_ion_pair(pair_name: str) -> tuple[str, str]:
    if pair_name == 'k-cl':
        return 'K+', 'Cl-'
    return 'Na+', 'Cl-'


def compute_step_count(duration_value: float, duration_unit: str, timestep_fs: float) -> int:
    if duration_unit == 'ns':
        total_fs = duration_value * 1_000_000.0
    else:
        total_fs = duration_value * 1_000.0
    return max(1, int(round(total_fs / timestep_fs)))


def extract_pdb_identifier(item: dict) -> str:
    data = item.get('data') or {}
    identifier = data.get('identifier') or item.get('title', '').split(' - ')[0] or item.get('id', '').split('-')[-1]
    identifier = str(identifier).strip().upper()
    if len(identifier) < 4:
        raise ValueError('Unable to determine a valid PDB identifier from the selected structure.')
    return identifier[:4]


def extract_uniprot_accession(item: dict) -> str:
    data = item.get('data') or {}
    for candidate in (
        data.get('primaryAccession'),
        item.get('title', '').split(' - ')[0],
        item.get('id', '').split('-')[-1]
    ):
        if candidate:
            return str(candidate).strip().upper()
    raise ValueError('Unable to determine a UniProt accession for the selected AlphaFold or UniProt record.')


def extract_numeric_suffix(value: str) -> str:
    digits = ''.join(character for character in str(value) if character.isdigit())
    return digits


def extract_chembl_identifier(value: str) -> str:
    upper_value = str(value).upper()
    for part in upper_value.split('-'):
        if part.startswith('CHEMBL'):
            return part
    return ''


def write_json(file_path: Path, value: dict) -> None:
    file_path.parent.mkdir(parents=True, exist_ok=True)
    file_path.write_text(f"{json.dumps(value, indent=2)}\n", encoding='utf-8')


def to_relative_path(file_path: Path, root_dir: Path) -> str:
    return file_path.resolve().relative_to(root_dir.resolve()).as_posix()


def iso_now() -> str:
    return datetime.datetime.now(datetime.UTC).replace(microsecond=0).isoformat().replace('+00:00', 'Z')


def log_message(level: str, message: str) -> None:
    print(f'{level.upper()}|{message}', flush=True)


if __name__ == '__main__':
    sys.exit(main())