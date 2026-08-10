/**
 * CREBAIN has no runtime source that attests transport security configuration.
 * Keep the closed status set fail-closed until such a source is implemented.
 * Use `not-configured` only when an authoritative source reports that state.
 */
export type SecurityConfigurationStatus = 'not-configured' | 'unknown'

interface SecurityConfigurationPresentation {
  label: string
  statusText: string
  description: string
  color: string
}

const SECURITY_CONFIGURATION_PRESENTATION: Record<
  SecurityConfigurationStatus,
  SecurityConfigurationPresentation
> = {
  'not-configured': {
    label: 'NICHT KONFIG.',
    statusText: 'not configured',
    description:
      'No transport security configuration is reported. This status does not attest TLS or access-control enforcement.',
    color: 'bg-[#505050]',
  },
  unknown: {
    label: 'UNBEKANNT',
    statusText: 'unknown',
    description:
      'Transport security configuration status is unknown. This status does not attest TLS or access-control enforcement.',
    color: 'bg-[#404040]',
  },
}

export function getSecurityConfigurationPresentation(
  status: SecurityConfigurationStatus
): SecurityConfigurationPresentation {
  return SECURITY_CONFIGURATION_PRESENTATION[status]
}

export function getSecurityConfigurationStatusLabel(status: SecurityConfigurationStatus): string {
  return getSecurityConfigurationPresentation(status).label
}
