export function notFound(req, res) {
  res.status(404).json({ error: 'Route not found' });
}

export function errorHandler(err, req, res, next) {
  console.error(err);
  if (err?.code === 11000) {
    return res.status(409).json({ error: 'Duplicate entry', details: err.keyValue });
  }
  if (err?.name === 'ZodError') {
    return res.status(400).json({ error: 'Validation failed', details: err.errors });
  }
  res.status(err.status || 500).json({
    error: err.publicMessage || 'Internal server error'
  });
}
