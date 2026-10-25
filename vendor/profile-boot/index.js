/**
 * Named exports over the vendored `profile-boot` implementation.
 *
 * The upstream file is kept byte-for-byte except for the patches recorded in
 * `PATCHES.md`; this wrapper only gives the minified exports readable names.
 */
import {
    a as prepareProfile,
    i as initializeProfileFromDefault,
    n as PROFILE_ROOT_FILENAME,
    o as runProfile,
    r as homePatchPath,
    t as INSTALL_ANCHOR,
} from "./profile-boot.js";

export {
    prepareProfile,
    initializeProfileFromDefault,
    PROFILE_ROOT_FILENAME,
    runProfile,
    homePatchPath,
    INSTALL_ANCHOR,
};
