/** Resolve ANT+ settings while preserving explicit CLI precedence over JSON. */
export function resolveAntOptions({antEnabled, antPlus, antAuto, providedOptions = []}) {
  const provided = providedOptions instanceof Set
    ? providedOptions
    : new Set(providedOptions);
  let enabled;

  if (provided.has('antEnabled')) {
    enabled = antEnabled;
  } else if (provided.has('antPlus')) {
    enabled = antPlus;
  } else if (typeof antEnabled === 'boolean') {
    enabled = antEnabled;
  }

  const auto = antAuto === undefined ? true : antAuto;
  return {
    antAuto: auto,
    antEnabled: enabled === undefined ? Boolean(auto) : enabled,
    antEnabledExplicit: provided.has('antEnabled') || provided.has('antPlus'),
  };
}
