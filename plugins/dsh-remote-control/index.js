/**
 * dsh-remote-control — bundle entry.
 *
 * The module surface lives in service.js; this file is the stable import
 * target the Loader activates (`export default` service class form).
 */

export { name, Config, badRequest, envelopeFetch, RemoteControlService, default } from './service.js'
