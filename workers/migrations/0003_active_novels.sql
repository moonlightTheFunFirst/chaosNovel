CREATE INDEX IF NOT EXISTS novels_active ON novels(id) WHERE count < capacity;
