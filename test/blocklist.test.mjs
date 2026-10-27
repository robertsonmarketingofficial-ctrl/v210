import { test } from 'node:test'
import assert from 'node:assert/strict'
import { blockReason, parseExtra } from '../components/blocklist.js'

test('blocks emergency services, councils and government', () => {
  for (const name of ['SES Salisbury Unit', 'State Emergency Service Tea Tree Gully', 'City of Playford', 'Adelaide Hills Council Depot', 'CFS Kersbrook Brigade', 'Metropolitan Fire Service'])
    assert.ok(blockReason({ name }), name)
  assert.ok(blockReason({ name: 'Arborists', email: 'jobs@sa.gov.au' }))
  assert.ok(blockReason({ name: 'Depot', types: ['local_government_office'] }))
})

test('lets real trade businesses through', () => {
  for (const name of ['Smith Tree Services', 'Green Edge Tree Lopping', 'Seaside Trees', 'Northern Stump Grinding'])
    assert.equal(blockReason({ name, email: 'info@example.com.au' }), null, name)
})

test('Never email list matches names and domains', () => {
  const extra = parseExtra('bunnings, @competitor.com.au')
  assert.ok(blockReason({ name: 'Bunnings Salisbury' }, extra))
  assert.ok(blockReason({ name: 'X', email: 'a@competitor.com.au' }, extra))
  assert.equal(blockReason({ name: 'X', email: 'a@other.com.au' }, extra), null)
})
