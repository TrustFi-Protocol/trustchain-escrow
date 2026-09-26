function buildSuccessEnvelope(data, meta = {}) {
  return {
    success: true,
    data,
    error: null,
    meta,
  };
}

function buildErrorEnvelope(error, meta = {}) {
  return {
    success: false,
    data: null,
    error: normalizeEnvelopeError(error),
    meta,
  };
}

function buildPaginatedEnvelope(data, pagination, meta = {}) {
  return buildSuccessEnvelope(data, {
    ...meta,
    pagination: {
      limit: pagination.limit,
      nextCursor: pagination.nextCursor ?? null,
      previousCursor: pagination.previousCursor ?? null,
      total: pagination.total ?? null,
      hasMore: Boolean(pagination.hasMore),
    },
  });
}

function normalizeEnvelopeError(error) {
  if (!error) {
    return {
      code: 'UNKNOWN_ERROR',
      message: 'An unknown error occurred.',
      details: null,
    };
  }

  if (typeof error === 'string') {
    return {
      code: 'ERROR',
      message: error,
      details: null,
    };
  }

  return {
    code: error.code ?? 'ERROR',
    message: error.message ?? 'An error occurred.',
    details: error.details ?? null,
  };
}

module.exports = {
  buildSuccessEnvelope,
  buildErrorEnvelope,
  buildPaginatedEnvelope,
  normalizeEnvelopeError,
};
