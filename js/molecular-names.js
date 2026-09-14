// Amino acid three-letter to full name mapping
const AMINO_ACIDS = {
    'ALA': 'Alanine',
    'ARG': 'Arginine',
    'ASN': 'Asparagine',
    'ASP': 'Aspartic Acid',
    'CYS': 'Cysteine',
    'GLN': 'Glutamine',
    'GLU': 'Glutamic Acid',
    'GLY': 'Glycine',
    'HIS': 'Histidine',
    'ILE': 'Isoleucine',
    'LEU': 'Leucine',
    'LYS': 'Lysine',
    'MET': 'Methionine',
    'PHE': 'Phenylalanine',
    'PRO': 'Proline',
    'SER': 'Serine',
    'THR': 'Threonine',
    'TRP': 'Tryptophan',
    'TYR': 'Tyrosine',
    'VAL': 'Valine',
    'SEC': 'Selenocysteine',
    'PYL': 'Pyrrolysine',
    'MSE': 'Selenomethionine'
};

// Nucleic acid base names
const NUCLEIC_ACIDS = {
    'A': 'Adenine',
    'C': 'Cytosine',
    'G': 'Guanine',
    'T': 'Thymine',
    'U': 'Uracil',
    'DA': 'Deoxyadenosine',
    'DC': 'Deoxycytidine',
    'DG': 'Deoxyguanosine',
    'DT': 'Deoxythymidine',
    'DU': 'Deoxyuridine',
    'AMP': 'Adenosine Monophosphate',
    'CMP': 'Cytidine Monophosphate',
    'GMP': 'Guanosine Monophosphate',
    'TMP': 'Thymidine Monophosphate',
    'UMP': 'Uridine Monophosphate'
};

// Common ligands
const COMMON_LIGANDS = {
    'HOH': 'Water',
    'ATP': 'Adenosine Triphosphate',
    'ADP': 'Adenosine Diphosphate',
    'GTP': 'Guanosine Triphosphate',
    'GDP': 'Guanosine Diphosphate',
    'NAD': 'Nicotinamide Adenine Dinucleotide',
    'NAP': 'NADP',
    'FAD': 'Flavin Adenine Dinucleotide',
    'FMN': 'Flavin Mononucleotide',
    'HEM': 'Heme',
    'HEC': 'Heme C',
    'PLP': 'Pyridoxal Phosphate',
    'COA': 'Coenzyme A',
    'SAH': 'S-Adenosyl-L-Homocysteine',
    'SAM': 'S-Adenosyl-L-Methionine',
    'ACO': 'Acetyl Coenzyme A',
    'PO4': 'Phosphate',
    'SO4': 'Sulfate',
    'GOL': 'Glycerol',
    'EDO': 'Ethylene Glycol',
    'DMS': 'Dimethyl Sulfoxide',
    'BME': 'Beta-Mercaptoethanol',
    'DTT': 'Dithiothreitol',
    'NAG': 'N-Acetyl-D-Glucosamine',
    'GLU': 'Glucose',
    'GAL': 'Galactose',
    'MAN': 'Mannose',
    'FUC': 'Fucose',
    'GLC': 'Glucose',
    'BGC': 'Beta-D-Glucose',
    'ACE': 'Acetate',
    'ACT': 'Acetate Ion',
    'PEG': 'Polyethylene Glycol',
    'TRS': 'Tris Buffer',
    'EPE': 'Phosphoethanolamine',
    'CIT': 'Citrate',
    'FMT': 'Formate',
    'MPD': 'Methylpentanediol',
    'IPA': 'Isopropanol',
    'ETF': 'Trifluoroethanol'
};

// Common atom type names - Comprehensive list
const ATOM_TYPES = {
    // Backbone atoms
    'N': 'Nitrogen (Backbone)',
    'CA': 'Alpha Carbon (Backbone)',
    'C': 'Carbon (Carbonyl, Backbone)',
    'O': 'Oxygen (Carbonyl, Backbone)',
    'OXT': 'Oxygen (C-Terminal)',
    
    // Beta position
    'CB': 'Beta Carbon',
    'OG': 'Oxygen (Gamma)',
    'OG1': 'Oxygen (Gamma 1)',
    'CG1': 'Gamma Carbon 1',
    'CG2': 'Gamma Carbon 2',
    
    // Gamma position
    'CG': 'Gamma Carbon',
    'SG': 'Sulfur (Gamma)',
    'OG': 'Oxygen (Gamma)',
    'NG': 'Nitrogen (Gamma)',
    
    // Delta position
    'CD': 'Delta Carbon',
    'CD1': 'Delta Carbon 1',
    'CD2': 'Delta Carbon 2',
    'SD': 'Sulfur (Delta)',
    'OD1': 'Oxygen (Delta 1)',
    'OD2': 'Oxygen (Delta 2)',
    'ND1': 'Nitrogen (Delta 1)',
    'ND2': 'Nitrogen (Delta 2)',
    
    // Epsilon position
    'CE': 'Epsilon Carbon',
    'CE1': 'Epsilon Carbon 1',
    'CE2': 'Epsilon Carbon 2',
    'CE3': 'Epsilon Carbon 3',
    'NE': 'Nitrogen (Epsilon)',
    'NE1': 'Nitrogen (Epsilon 1)',
    'NE2': 'Nitrogen (Epsilon 2)',
    'OE1': 'Oxygen (Epsilon 1)',
    'OE2': 'Oxygen (Epsilon 2)',
    
    // Zeta position
    'CZ': 'Zeta Carbon',
    'CZ2': 'Zeta Carbon 2',
    'CZ3': 'Zeta Carbon 3',
    'NZ': 'Nitrogen (Zeta)',
    
    // Eta position
    'NH1': 'Nitrogen (Eta 1)',
    'NH2': 'Nitrogen (Eta 2)',
    'CH2': 'Carbon (Eta 2)',
    
    // Hydrogens (all positions)
    'H': 'Hydrogen (Backbone N)',
    'H1': 'Hydrogen 1',
    'H2': 'Hydrogen 2',
    'H3': 'Hydrogen 3',
    'HA': 'Hydrogen (Alpha)',
    'HA2': 'Hydrogen (Alpha 2)',
    'HA3': 'Hydrogen (Alpha 3)',
    'HB': 'Hydrogen (Beta)',
    'HB1': 'Hydrogen (Beta 1)',
    'HB2': 'Hydrogen (Beta 2)',
    'HB3': 'Hydrogen (Beta 3)',
    'HG': 'Hydrogen (Gamma)',
    'HG1': 'Hydrogen (Gamma 1)',
    'HG2': 'Hydrogen (Gamma 2)',
    'HG3': 'Hydrogen (Gamma 3)',
    'HG11': 'Hydrogen (Gamma 11)',
    'HG12': 'Hydrogen (Gamma 12)',
    'HG13': 'Hydrogen (Gamma 13)',
    'HG21': 'Hydrogen (Gamma 21)',
    'HG22': 'Hydrogen (Gamma 22)',
    'HG23': 'Hydrogen (Gamma 23)',
    'HD1': 'Hydrogen (Delta 1)',
    'HD2': 'Hydrogen (Delta 2)',
    'HD3': 'Hydrogen (Delta 3)',
    'HD11': 'Hydrogen (Delta 11)',
    'HD12': 'Hydrogen (Delta 12)',
    'HD13': 'Hydrogen (Delta 13)',
    'HD21': 'Hydrogen (Delta 21)',
    'HD22': 'Hydrogen (Delta 22)',
    'HD23': 'Hydrogen (Delta 23)',
    'HE': 'Hydrogen (Epsilon)',
    'HE1': 'Hydrogen (Epsilon 1)',
    'HE2': 'Hydrogen (Epsilon 2)',
    'HE3': 'Hydrogen (Epsilon 3)',
    'HE21': 'Hydrogen (Epsilon 21)',
    'HE22': 'Hydrogen (Epsilon 22)',
    'HZ': 'Hydrogen (Zeta)',
    'HZ1': 'Hydrogen (Zeta 1)',
    'HZ2': 'Hydrogen (Zeta 2)',
    'HZ3': 'Hydrogen (Zeta 3)',
    'HH': 'Hydrogen (Eta)',
    'HH11': 'Hydrogen (Eta 11)',
    'HH12': 'Hydrogen (Eta 12)',
    'HH21': 'Hydrogen (Eta 21)',
    'HH22': 'Hydrogen (Eta 22)',
    
    // Sulfur atoms
    'S': 'Sulfur',
    'SG': 'Sulfur (Gamma)',
    'SD': 'Sulfur (Delta)',
    
    // Nucleic acid atoms
    'P': 'Phosphorus',
    'OP1': 'Oxygen (Phosphate 1)',
    'OP2': 'Oxygen (Phosphate 2)',
    'OP3': 'Oxygen (Phosphate 3)',
    "O5'": "Oxygen (5' Ribose)",
    "C5'": "Carbon (5' Ribose)",
    "C4'": "Carbon (4' Ribose)",
    "O4'": "Oxygen (4' Ribose)",
    "C3'": "Carbon (3' Ribose)",
    "O3'": "Oxygen (3' Ribose)",
    "C2'": "Carbon (2' Ribose)",
    "O2'": "Oxygen (2' Ribose)",
    "C1'": "Carbon (1' Ribose)",
    
    // Base atoms
    'N1': 'Nitrogen 1 (Base)',
    'N2': 'Nitrogen 2 (Base)',
    'N3': 'Nitrogen 3 (Base)',
    'N4': 'Nitrogen 4 (Base)',
    'N6': 'Nitrogen 6 (Base)',
    'N7': 'Nitrogen 7 (Base)',
    'N9': 'Nitrogen 9 (Base)',
    'C2': 'Carbon 2 (Base)',
    'C4': 'Carbon 4 (Base)',
    'C5': 'Carbon 5 (Base)',
    'C6': 'Carbon 6 (Base)',
    'C8': 'Carbon 8 (Base)',
    'O2': 'Oxygen 2 (Base)',
    'O4': 'Oxygen 4 (Base)',
    'O6': 'Oxygen 6 (Base)'
};

// Common ion names
const IONS = {
    'ZN': 'Zinc',
    'MG': 'Magnesium',
    'CA': 'Calcium',
    'FE': 'Iron',
    'NA': 'Sodium',
    'K': 'Potassium',
    'CL': 'Chloride',
    'MN': 'Manganese',
    'CU': 'Copper',
    'NI': 'Nickel',
    'CO': 'Cobalt',
    'CD': 'Cadmium',
    'HG': 'Mercury',
    'BR': 'Bromide',
    'I': 'Iodide',
    'FE2': 'Iron(II)',
    'FE3': 'Iron(III)',
    'ZN2': 'Zinc(II)',
    'CU1': 'Copper(I)',
    'CU2': 'Copper(II)'
};

// Common ligand names (frequently seen in PDB)
// Chemical element full names
const ELEMENTS = {
    'H': 'Hydrogen',
    'C': 'Carbon',
    'N': 'Nitrogen',
    'O': 'Oxygen',
    'P': 'Phosphorus',
    'S': 'Sulfur',
    'F': 'Fluorine',
    'CL': 'Chlorine',
    'BR': 'Bromine',
    'I': 'Iodine',
    'NA': 'Sodium',
    'MG': 'Magnesium',
    'K': 'Potassium',
    'CA': 'Calcium',
    'FE': 'Iron',
    'ZN': 'Zinc',
    'CU': 'Copper',
    'MN': 'Manganese',
    'CO': 'Cobalt',
    'NI': 'Nickel',
    'SE': 'Selenium',
    'MO': 'Molybdenum',
    'W': 'Tungsten',
    'V': 'Vanadium',
    'CR': 'Chromium',
    'CD': 'Cadmium',
    'HG': 'Mercury',
    'AL': 'Aluminum',
    'SI': 'Silicon',
    'B': 'Boron',
    'AS': 'Arsenic'
};

// Helper function to get full name with fallback
function getFullName(code, type) {
    code = code.toUpperCase();
    
    switch(type) {
        case 'amino':
            return AMINO_ACIDS[code] || code;
        case 'nucleic':
            return NUCLEIC_ACIDS[code] || code;
        case 'atom':
            return ATOM_TYPES[code] || code;
        case 'ion':
            return IONS[code] || code;
        case 'ligand':
            return COMMON_LIGANDS[code] || code;
        case 'element':
            return ELEMENTS[code] || code;
        default:
            return code;
    }
}

// Format display name with abbreviation
// Expected atoms for each amino acid (including hydrogens typically resolved in high-res structures)
const EXPECTED_ATOMS = {
    'ALA': ['N', 'CA', 'C', 'O', 'CB', 'H', 'HA', 'HB1', 'HB2', 'HB3'],
    'ARG': ['N', 'CA', 'C', 'O', 'CB', 'CG', 'CD', 'NE', 'CZ', 'NH1', 'NH2', 'H', 'HA', 'HB2', 'HB3', 'HG2', 'HG3', 'HD2', 'HD3', 'HE', 'HH11', 'HH12', 'HH21', 'HH22'],
    'ASN': ['N', 'CA', 'C', 'O', 'CB', 'CG', 'OD1', 'ND2', 'H', 'HA', 'HB2', 'HB3', 'HD21', 'HD22'],
    'ASP': ['N', 'CA', 'C', 'O', 'CB', 'CG', 'OD1', 'OD2', 'H', 'HA', 'HB2', 'HB3'],
    'CYS': ['N', 'CA', 'C', 'O', 'CB', 'SG', 'H', 'HA', 'HB2', 'HB3', 'HG'],
    'GLN': ['N', 'CA', 'C', 'O', 'CB', 'CG', 'CD', 'OE1', 'NE2', 'H', 'HA', 'HB2', 'HB3', 'HG2', 'HG3', 'HE21', 'HE22'],
    'GLU': ['N', 'CA', 'C', 'O', 'CB', 'CG', 'CD', 'OE1', 'OE2', 'H', 'HA', 'HB2', 'HB3', 'HG2', 'HG3'],
    'GLY': ['N', 'CA', 'C', 'O', 'H', 'HA2', 'HA3'],
    'HIS': ['N', 'CA', 'C', 'O', 'CB', 'CG', 'ND1', 'CD2', 'CE1', 'NE2', 'H', 'HA', 'HB2', 'HB3', 'HD1', 'HD2', 'HE1', 'HE2'],
    'ILE': ['N', 'CA', 'C', 'O', 'CB', 'CG1', 'CG2', 'CD1', 'H', 'HA', 'HB', 'HG12', 'HG13', 'HG21', 'HG22', 'HG23', 'HD11', 'HD12', 'HD13'],
    'LEU': ['N', 'CA', 'C', 'O', 'CB', 'CG', 'CD1', 'CD2', 'H', 'HA', 'HB2', 'HB3', 'HG', 'HD11', 'HD12', 'HD13', 'HD21', 'HD22', 'HD23'],
    'LYS': ['N', 'CA', 'C', 'O', 'CB', 'CG', 'CD', 'CE', 'NZ', 'H', 'HA', 'HB2', 'HB3', 'HG2', 'HG3', 'HD2', 'HD3', 'HE2', 'HE3', 'HZ1', 'HZ2', 'HZ3'],
    'MET': ['N', 'CA', 'C', 'O', 'CB', 'CG', 'SD', 'CE', 'H', 'HA', 'HB2', 'HB3', 'HG2', 'HG3', 'HE1', 'HE2', 'HE3'],
    'PHE': ['N', 'CA', 'C', 'O', 'CB', 'CG', 'CD1', 'CD2', 'CE1', 'CE2', 'CZ', 'H', 'HA', 'HB2', 'HB3', 'HD1', 'HD2', 'HE1', 'HE2', 'HZ'],
    'PRO': ['N', 'CA', 'C', 'O', 'CB', 'CG', 'CD', 'HA', 'HB2', 'HB3', 'HG2', 'HG3', 'HD2', 'HD3'],
    'SER': ['N', 'CA', 'C', 'O', 'CB', 'OG', 'H', 'HA', 'HB2', 'HB3', 'HG'],
    'THR': ['N', 'CA', 'C', 'O', 'CB', 'OG1', 'CG2', 'H', 'HA', 'HB', 'HG1', 'HG21', 'HG22', 'HG23'],
    'TRP': ['N', 'CA', 'C', 'O', 'CB', 'CG', 'CD1', 'CD2', 'NE1', 'CE2', 'CE3', 'CZ2', 'CZ3', 'CH2', 'H', 'HA', 'HB2', 'HB3', 'HD1', 'HE1', 'HE3', 'HZ2', 'HZ3', 'HH2'],
    'TYR': ['N', 'CA', 'C', 'O', 'CB', 'CG', 'CD1', 'CD2', 'CE1', 'CE2', 'CZ', 'OH', 'H', 'HA', 'HB2', 'HB3', 'HD1', 'HD2', 'HE1', 'HE2', 'HH'],
    'VAL': ['N', 'CA', 'C', 'O', 'CB', 'CG1', 'CG2', 'H', 'HA', 'HB', 'HG11', 'HG12', 'HG13', 'HG21', 'HG22', 'HG23'],
    'SEC': ['N', 'CA', 'C', 'O', 'CB', 'SEG', 'H', 'HA', 'HB2', 'HB3'],
    'PYL': ['N', 'CA', 'C', 'O', 'CB', 'CG', 'CD', 'CE', 'NZ', 'H', 'HA', 'HB2', 'HB3', 'HG2', 'HG3', 'HD2', 'HD3', 'HE2', 'HE3']
};

function formatName(code, type) {
    const fullName = getFullName(code, type);
    if (fullName === code) {
        return code; // No full name found, just return code
    }
    return `${code} - ${fullName}`;
}
