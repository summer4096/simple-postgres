# simple-postgres

[![Greenkeeper badge](https://badges.greenkeeper.io/summer4096/simple-postgres.svg)](https://greenkeeper.io/)
a minimal postgres interface for node

```console
npm install simple-postgres
```

### Features

* zero configuration, uses DATABASE_URL
* shortcuts for getting the first row, first value, etc
* transactions
* es6 template strings for query assembly
* very high test coverage
* very few lines of code
* only depends on pg and a connection string parser

### Usage

```js
import db from 'simple-postgres'

function countPancakes () {
  return db.value('SELECT COUNT(*) FROM breakfast WHERE type = $1', ['pancake'])
}
```

### API

##### db.query(sql, params = [])
run a query

returns a promise, which resolves with a pg [Result](https://github.com/brianc/node-postgres/wiki/Query#result-object) object

This is best for INSERT/UPDATE/DELETE/etc queries which will not return any rows. If you are doing a SELECT, you probably want one of the functions below.

##### db.rows(sql, params = [])
run a query

returns a promise, which resolves with an array of row objects

##### db.row(sql, params = [])
run a query

returns a promise, which resolves with the first row object

Unlike other really terrible database libraries, this will not add `LIMIT 1` to the end of the query, and so that must be done manually if needed.

##### db.value(sql, params = [])
run a query

returns a promise, which resolves with the first column of the first row

This is useful for things like counts.

##### db.column(sql, params = [])
run a query

returns a promise, which resolves with an array of the first values in each row

Example:
```js
db.column('SELECT * FROM generate_series(1, 5)')
// => [1, 2, 3, 4, 5]
```

##### template string mode

Any of the above functions can be used with template string literals to make
long queries more readable. Interpolated values will be moved to the `params`
array and replaced with $1, $2, etc. *Do not use parentheses around your
template string or you will open yourself up to SQL injection attacks and you
will have a bad day.*

Example:
```js
let type = 'pancake'
// the following two calls are identical:
db.value`
  SELECT COUNT(*)
  FROM breakfast
  WHERE type = ${type}
`
db.value('SELECT COUNT(*) FROM breakfast WHERE type = $1', [type])
```

If you need to interpolate an identifier such as a table name, the normal
escaping will wrap your value in single quotes and prevent your query from
working. You want the `db.identifier` function for this.

Example:
```js
let table = 'breakfast'
let type = 'pancake'

db.value`
  SELECT COUNT(*)
  FROM ${db.identifier(table)}
  WHERE type = ${type}
`
```

##### db.transaction(block)
perform a [database transaction](https://www.postgresql.org/docs/current/static/tutorial-transactions.html)

**block**: should be a function which will perform work inside the transaction and return a promise. If the promise rejects, the transaction will be rolled back.

returns a promise, which should resolve with the return value of **block** or reject if the transaction failed

Example:
```js
// process one order
db.transaction(async function (trx) {
  let orderId = await trx.value('SELECT id FROM orders WHERE NOT shipped LIMIT 1 FOR UPDATE')

  await db.query('INSERT INTO shipments (order_id) VALUES ($1)', [orderId])

  // if this update fails, the above insert will be rolled back!
  await db.query('UPDATE orders SET fulfilled = true WHERE id = $1', [orderId])

  return orderId
})
```

##### db.connection(block)
perform multiple queries sequentially on a single connection

**block**: should be a function which will perform work inside the connection
and return a promise. When the promise resolves or rejects, the connection will
be returned to the pool.

Example:
```js
let cookies = await db.connection(async function ({ query, value }) {
  // count the number of cookies, or timeout if it takes more than a minute
  await query('SET statement_timeout=60000')
  return value('SELECT COUNT(*) FROM cookies')
})
```

##### Query cancellation
The promises returned by `db.query`, `db.rows`, etc all have a `cancel` method
which will kill the query on the backend.

Example:
```js
let query = db.query('SELECT COUNT(*) FROM slow_table')

query.catch(err => {
  if (err instanceof db.Cancel) {
    console.log('query cancelled')
  } else {
    console.error('unexpected error', err)
  }
})

q.cancel().then(() => console.log('cancel resolved'))

// STDOUT:
// query cancelled
// cancel resolved
```

An obscure note about cancellation: `db.connection` and `db.transaction` do not
have `.cancel()` methods, although you can cancel individual queries you run
within them.

##### db.escape(value)
escape a value for safe use in SQL queries, returns string

While this function is tested and probably secure, you should avoid using it.
Instead, use bind vars, as they are much more difficult to mess up.

##### db.escapeIdentifier(value)
escape a value for safe use as an identifier in SQL queries, returns string

Same as the above function, except for things like table names, column names,
etc.

### Contributing

Please send pull requests!
