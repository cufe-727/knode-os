import { registerFinanceRecipes } from './finance.js';
import { registerLawRecipes } from './law.js';
import { registerLiteratureRecipes } from './literature.js';
import { registerMedicineRecipes } from './medicine.js';
import { registerPersonalRecipes } from './personal.js';
import { registerPublicRecipes } from './public.js';
import { registerResearchRecipes } from './research.js';
import { registerSyntheticRecipes } from './synthetic.js';

/**
 * Registers every pack recipe beside the fixture (docs/design/23 §2). Each
 * domain's recipes live in their own module; importing this one makes them
 * all available to `knode-os eval pack build`.
 */
registerSyntheticRecipes();
registerLiteratureRecipes();
registerResearchRecipes();
registerLawRecipes();
registerMedicineRecipes();
registerPersonalRecipes();
registerFinanceRecipes();
registerPublicRecipes();
