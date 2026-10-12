This README file was generated on 2023-07-17 by Brian L. Edlow, M.D.

GENERAL INFORMATION

1. Title of Dataset: Harvard Ascending Arousal Network Atlas - Version 2.0

2. Author Information:

Brian L. Edlow, M.D.
Center for Neurotechnology and Neurorecovery
Massachusetts General Hospital
Department of Neurology
Boston, MA USA
Email: bedlow@mgh.harvard.edu

Hannah C. Kinney, M.D.
Boston Children's Hospital
Department of Pathology
Boston, MA USA
Email: Hannah.Kinney@childrens.harvard.edu

3. Date of data collection: 2013-2023

4. Geographic location of data collection: Boston, MA USA

5. Information about funding sources supported the collection of the data:

NIH Office of the Director, Award: DP2HD101400
National Institute of Neurological Disorders and Stroke, Award: R21NS109627
James S. McDonnell Foundation
Chen Institute MGH Research Scholar

SHARING/ACCESS INFORMATION

1. Licenses/restrictions placed on the data: CC0 1.0 Universal (CC0 1.0) Public Domain

2. Links to publications that cite or use the data:

Sustaining wakefulness: Brainstem connectivity in human consciousness
Brian L Edlow, Mark Olchanyi, Holly J Freeman, Jian Li, Chiara Maffei, Samuel B Snider, Lilla Zollei, Juan Eugenio Iglesias, Jean Augustinack, Yelena G. Bodien, Robin L Haynes, Douglas N Greve, Bram R Diamond, Allison Stevens, Joseph T Giacino, Christophe Destrieux, Andre van der Kouwe, Emery N Brown, Rebecca D Folkerth, Bruce Fischl, Hannah C Kinney
bioRxiv 2023.07.13.548265; doi: https://doi.org/10.1101/2023.07.13.548265

3. Links to other publicly accessible locations of the data: None

4. Links/relationships to ancillary data sets: None

5. Was data derived from another source? No
	A. If yes, list source(s): NA

6. Recommended citation for this dataset:

Edlow, BL; Kinney, HC (2023), Harvard Ascending Arousal Network Atlas – Version 2.0, Dryad Digital Repository, https://doi.org/10.5061/dryad.zw3r228d2

DATA & FILE OVERVIEW

1. File List:

AAN_Brainstem_MNI152_1mm_v2p0.niiAAN_Brainstem_v2p0_Color_LUT_FreeSurfer.txtAAN_DR_MNI152_1mm_v2p0.niiAAN_LC_L_MNI152_1mm_v2p0.niiAAN_LC_MNI152_1mm_v2p0.niiAAN_LC_R_MNI152_1mm_v2p0.niiAAN_LDTg_L_MNI152_1mm_v2p0.niiAAN_LDTg_MNI152_1mm_v2p0.niiAAN_LDTg_R_MNI152_1mm_v2p0.niiAAN_MnR_MNI152_1mm_v2p0.niiAAN_mRt_L_MNI152_1mm_v2p0.niiAAN_mRt_MNI152_1mm_v2p0.niiAAN_mRt_R_MNI152_1mm_v2p0.niiAAN_PAG_MNI152_1mm_v2p0.niiAAN_PBC_L_MNI152_1mm_v2p0.niiAAN_PBC_MNI152_1mm_v2p0.niiAAN_PBC_R_MNI152_1mm_v2p0.niiAAN_PnO_L_MNI152_1mm_v2p0.niiAAN_PnO_MNI152_1mm_v2p0.niiAAN_PnO_R_MNI152_1mm_v2p0.niiAAN_PTg_L_MNI152_1mm_v2p0.niiAAN_PTg_MNI152_1mm_v2p0.niiAAN_PTg_R_MNI152_1mm_v2p0.niiAAN_VTA_MNI152_1mm_v2p0.nii

2. Relationship between files, if important: None

3. Additional related data collected that was not included in the current data package: None

4. Are there multiple versions of the dataset? No
	A. If yes, name of file(s) that was updated: NA
		i. Why was the file updated? NA
		ii. When was the file updated? NA



#########################################################################

DATA-SPECIFIC INFORMATION: Ascending Arousal Network (AAN) Nodes 

1. AAN Node Abbreviations:

DR = dorsal raphe
LC = locus coeruleus
LDTg = laterodorsal tegmental nucleus
MnR = median raphe
mRt = mesencephalic reticular formation
PAG = periaqueductal grey
PBC = parabrachial complex
PnO = pontis oralis (i.e., pontine reticular formation)
PTg = pedunculotegmental nucleus
VTA = ventral tegmental area

2. Additional Abbreviations:

L = left
R = right
MNI152 1mm = Montreal Neurological Institute 152 stereotactic space at 1 mm isotropic resolution

3. AAN_Brainstem_MNI152_1mm_v2p0.nii = a single nifti files that combines all AAN nodes


DATA-SPECIFIC INFORMATION: Color Look-up Table (LUT) for FreeSurfer

1. Number of variables/columns: 6

2. Number of rows: 23

3. Variable List:
	
	* Column 1 = numeric value assigned to color in FreeSurfer
	
	* Column 2 = name of AAN node

	* Column 3 = red color in RGB color code system

	* Column 4 = green color in RGB color code system

	* Column 5 = blue color in RGB color code system

	* Column 6 = 0 (placeholder per text file formatting in FreeSurfer LUTs)

4. Color LUT usage: this Color LUT text file can be uploaded to FreeSurfer's image viewer, FreeView, to color code the AAN nodes
