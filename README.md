# simple-postgres
a minimal postgres interface for node

```console
npm install simple-postgres
```

### Features

* zero configuration, uses DATABASE_URL
* shortcuts for getting the first row, first value, etc
* transactions
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

### Contributing

Please send pull requests!

### Wishlist

* configurable transaction isolation
* transaction savepoints
* tagged template strings for assembling sql
* escaping utility functions
