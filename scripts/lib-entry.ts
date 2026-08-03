/**
 * Entry point for the plain-Node library bundle (`npm run build:lib`).
 *
 * The Electron build produces a single main-process bundle that cannot be
 * imported from an ordinary Node script. This re-exports the parts of the
 * engine that are useful outside the app — reading a backup and checking what
 * is still alive — so command-line tools like `scripts/inspect-car.mjs` can use
 * the exact same code paths the GUI uses, rather than a reimplementation that
 * could drift.
 */
export { importCar, exportCar, exportBrowsableFolder } from '../src/main/ipfs/car'
export { openBlockstore } from '../src/main/ipfs/blockstore'
export { checkHealth, checkMany, checkProviders } from '../src/main/health/check'
export { listDirectory, cumulativeSize } from '../src/main/ipfs/dag'
export { addBytes, addDirectoryFromFs, reconstructCid } from '../src/main/ipfs/importer'
export { fetchDag } from '../src/main/ipfs/trustlessFetch'
