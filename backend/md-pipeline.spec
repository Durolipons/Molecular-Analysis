# -*- mode: python ; coding: utf-8 -*-

from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files, collect_dynamic_libs, collect_submodules, copy_metadata


PROJECT_ROOT = Path(SPECPATH).resolve().parent
BACKEND_ROOT = PROJECT_ROOT / 'backend'
DIST_ROOT = BACKEND_ROOT / 'dist' / 'win32-x64'
WORK_ROOT = BACKEND_ROOT / 'build' / 'pyinstaller'

SCIENTIFIC_PACKAGES = [
    'pdbfixer',
    'openmm',
    'openmm.app',
    'openmmforcefields',
    'rdkit',
    'rdkit.Chem',
    'openff.toolkit',
    'openff.units',
    'openff.utilities',
    'openff.interchange',
    'openforcefields',
    'constraint',
    'xmltodict'
]

hiddenimports = []
datas = []
binaries = []

for package_name in SCIENTIFIC_PACKAGES:
    try:
        hiddenimports += collect_submodules(package_name)
    except Exception:
        pass

for package_name in SCIENTIFIC_PACKAGES:
    try:
        datas += collect_data_files(package_name, include_py_files=True)
    except Exception:
        pass

# Explicitly include pdbfixer templates (may be missed when installed in user-roaming path)
import importlib.util as _ilu
_pdbfixer_spec = _ilu.find_spec('pdbfixer')
if _pdbfixer_spec and _pdbfixer_spec.origin:
    _pdbfixer_dir = Path(_pdbfixer_spec.origin).parent
    _templates_dir = _pdbfixer_dir / 'templates'
    if _templates_dir.is_dir() and not any(d[1] == 'pdbfixer/templates' for d in datas):
        datas.append((str(_templates_dir), 'pdbfixer/templates'))

for package_name in ['openmm', 'openmmforcefields', 'rdkit']:
    try:
        binaries += collect_dynamic_libs(package_name)
    except Exception:
        pass

for distribution_name in [
    'openmm',
    'pdbfixer',
    'openmmforcefields',
    'rdkit',
    'openff-toolkit',
    'openff-units',
    'openff-utilities',
    'openff-interchange',
    'openff-forcefields',
    'python-constraint',
    'xmltodict'
]:
    try:
        datas += copy_metadata(distribution_name)
    except Exception:
        pass

block_cipher = None

a = Analysis(
    [str(BACKEND_ROOT / 'md_pipeline.py')],
    pathex=[str(PROJECT_ROOT)],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)
pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='md-pipeline',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name='md-pipeline',
    distpath=str(DIST_ROOT),
    workpath=str(WORK_ROOT),
)