import test from 'blue-tape'
import db from '../src'
import pg from 'pg'
import 'babel-polyfill'

function countConnections () {
  return Object.values(pg.pools.all).map(
    pool => pool.availableObjectsCount()
  ).reduce((a, b) => a + b, 0)
}

function destroyConnections () {
  // break things by destroying all connections everywhere
  Object.values(pg.pools.all).forEach(
    (p) => p._inUseObjects.forEach(
      (c) => c.end()
    )
  )
}

test('db.query', async function (t) {
  let result = await db.query('select * from generate_series(1, 3) g')
  t.equal(result.rowCount, 3, 'should return result with rowCount property')
  t.equal(result.command, 'SELECT', 'should return result with command property')
  t.ok(Array.isArray(result.rows), 'should return result with rows property')
})

test('db.query (template string)', async function (t) {
  let result = await db.query`select * from generate_series(${1}::int, ${2 + 1}::int) g`
  t.equal(result.rowCount, 3, 'should return result with rowCount property')
  t.equal(result.command, 'SELECT', 'should return result with command property')
  t.ok(Array.isArray(result.rows), 'should return result with rows property')
})

test('db.rows', async function (t) {
  t.deepEqual(
    await db.rows('select * from generate_series(1, 3) g'),
    [1, 2, 3].map(
      (g) => ({g})
    ),
    'should return an array of objects'
  )
})

test('db.rows (template string)', async function (t) {
  t.deepEqual(
    await db.rows`select * from generate_series(${1}::int, ${2 + 1}::int) g`,
    [1, 2, 3].map(
      (g) => ({g})
    ),
    'should return an array of objects'
  )
})

test('db.row', async function (t) {
  t.deepEqual(
    await db.row('select 1 as a'),
    {a: 1},
    'should return a single object'
  )
})

test('db.row (template string)', async function (t) {
  t.deepEqual(
    await db.row`select ${1}::int as a`,
    {a: 1},
    'should return a single object'
  )
})

test('db.value', async function (t) {
  t.equal(
    await db.value('select 1'),
    1,
    'should return a single value'
  )
})

test('db.value (template string)', async function (t) {
  t.equal(
    await db.value`select ${1}::int`,
    1,
    'should return a single value'
  )
})

test('db.column', async function (t) {
  t.deepEqual(
    await db.column('select * from generate_series(1, 3)'),
    [1, 2, 3],
    'should return an array of the first value in each row'
  )
})

test('db.column (template string)', async function (t) {
  t.deepEqual(
    await db.column`select * from generate_series(${1}::int, ${3}::int)`,
    [1, 2, 3],
    'should return an array of the first value in each row'
  )
})

test('sql-injection-proof template strings', async function (t) {
  let evil = 'SELECT evil"\''
  t.equal(
    await db.value`SELECT ${evil}::text`,
    evil
  )
})

test('escaping', async function (t) {
  t.equal(db.escape('a\'a\\'), ' E\'a\'\'a\\\\\'')
})

test('identifier escaping', async function (t) {
  t.equal(db.escapeIdentifier('weird " ?'), '"weird "" ?"')
})

test('identifier template escaping', async function (t) {
  t.equal(
    await db.value`SELECT '${db.identifier('weird " string')}'::text`,
    '"weird "" string"'
  )
})

test('literal template escaping', async function (t) {
  let weird = 'a\'a\\'
  t.equal(
    await db.value`SELECT ${db.literal(weird)}::text`,
    weird
  )
})

test('successful transaction', async function (t) {
  await db.query('drop table if exists beep')
  await db.query('create table beep (id integer)')
  await db.query('insert into beep (id) values (1), (2), (3)')

  await db.transaction(async function (trx) {
    await trx.query('delete from beep where id=2')
    await trx.query('insert into beep (id) VALUES (4), (5), (6)')

    t.deepEqual(
      await db.column('select id from beep order by id'),
      [1, 2, 3],
      'changes are invisible outside transaction'
    )

    t.deepEqual(
      await trx.column('select id from beep order by id'),
      [1, 3, 4, 5, 6],
      'changes are visible inside transaction'
    )
  })

  t.deepEqual(
    await db.column('select id from beep order by id'),
    [1, 3, 4, 5, 6],
    'changes are visible after commit'
  )
})

test('bad connection url', async function (t) {
  try {
    await db.configure('postgres://example').query('select 1')
    t.fail('should not be able to connect to postgres://example')
  } catch (err) {
    t.equal(err.code, 'ENOTFOUND', 'incorrect host should throw ENOTFOUND')
  }
})

test('bad query', async function (t) {
  try {
    await db.query('not a real sql query lol')
    t.fail('should not be able to execute an invalid query')
  } catch (err) {
    t.equal(err.message, 'syntax error at or near "not"', 'should throw syntax error')
  }
})

test('bad sql in transaction', async function (t) {
  try {
    await db.transaction(async function ({ query }) {
      await query('not a real sql query lol')
    })
    t.fail('transaction errors should cause the promise to reject')
  } catch (err) {
    t.equal(err.ABORT_CONNECTION, undefined, 'transaction errors should be recoverable')
  }

  t.equal(
    countConnections(),
    1,
    'rollbacks should keep the connection in the pool'
  )
})

test('failed rollback', async function (t) {
  try {
    await db.transaction(async function ({ query }) {
      // break the transaction by destroying all connections everywhere
      destroyConnections()
      let e = new Error('initial transaction error')
      throw e
    })
    t.fail('transaction errors should cause the promise to reject')
  } catch (err) {
    t.ok(/Error: Failed to execute rollback after error\n/.test(err), 'broken rollback should explain what\'s up')
    t.ok(/Error: initial transaction error\n {4}at /.test(err), 'broken rollback should contain initial error stack')
    t.ok(/Error: Connection terminated\n {4}at /.test(err), 'broken rollback should contain the rollback error stack')
    t.equal(err.ABORT_CONNECTION, true, 'transaction errors should propagate up')
  }

  t.equal(
    countConnections(),
    0,
    'failed transaction rollbacks should remove the client from the pool'
  )
})
