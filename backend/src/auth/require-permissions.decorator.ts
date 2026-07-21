import { SetMetadata } from '@nestjs/common';

export const PERMISSIONS_KEY = 'requiredPermissions';

/**
 * Tag a route (or a whole controller) with the permission codes its caller must hold.
 * All listed codes are required (AND). Enforcement lives in PermissionsGuard.
 */
export const RequirePermissions = (...codes: string[]) => SetMetadata(PERMISSIONS_KEY, codes);
