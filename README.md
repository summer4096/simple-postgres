# simple-postgres

simple-postgres is a small and powerful PostgreSQL interface for Node.js

Replace all of your database boilerplate with `import db from 'simple-postgres'`
and never look back.

### Getting started

```console
npm install simple-postgres
```

```js
import db from 'simple-postgres'

let accountName = 'ACME\'; DELETE FROM accounts; --'

// this is totally safe
await db.query('INSERT INTO accounts (name) VALUES ($1)', [accountName])

// this is also totally safe
let account = await db.row`
  SELECT *
  FROM accounts
  WHERE name = ${accountName}
`

console.log(account.name) // => 'ACME\'; DELETE FROM accounts; --'
```

### Why?

Many other postgres modules are bad. This one is good. Here's why:

#### simple-postgres has everything you need
 * connects using the DATABASE_URL environment variable
 * runs queries and returns the results
 * automatic query parameterization
 * escaping literals, identifiers, arrays
 * transactions
 * async/await ready
 * sets application_name using package.json
 * good test coverage
 * trusted in production by my boss who trusts nothing

#### simple-postgres doesn't have anything you don't need
 * no ORM
 * no query builder
 * no connect function
 * no disconnect function
 * no connection pool manager
 * no configuration
 * no initialization
 * no callbacks

### API

##### db.query(sql, params = [])
run a query

returns a promise, which resolves with a pg [Result](https://node-postgres.com/api/result) object

This is best for INSERT/UPDATE/DELETE/etc queries which will not return any rows. If you are doing a SELECT, you probably want one of the functions below.

```js
let result = await db.query('UPDATE accounts SET enabled = true')
console.log(result.command + ' ' + result.rowCount) // => UPDATE 2
```

##### db.rows(sql, params = [])
run a query

returns a promise, which resolves with an array of row objects

```js
let accounts = await db.rows('SELECT * FROM accounts')
for (let account of accounts) {
  console.log(account.id + ': ' + account.name) // => "1: ACME"
}
```

##### db.row(sql, params = [])
run a query

returns a promise, which resolves with the first row object

This will **not** automatically add `LIMIT 1` to the end of the query.

```js
let account = await db.row('SELECT * FROM accounts WHERE id = 1')
console.log(account.name) // => "ACME"
```

##### db.value(sql, params = [])
run a query

returns a promise, which resolves with the first column of the first row

This is useful for things like counts.

```js
let accountName = await db.value('SELECT name FROM accounts WHERE id = 1')
console.log(accountName) // => "ACME"
```

##### db.column(sql, params = [])
run a query

returns a promise, which resolves with an array of the first values in each row

Example:
```js
let oneThroughFive = await db.column('SELECT * FROM generate_series(1, 5)')
console.log(oneThroughFive) // => [1, 2, 3, 4, 5]
```

##### template string mode

Any of the above functions can be used with template string literals to make
long queries more readable. Interpolated values will be moved to the `params`
array and replaced with $1, $2, etc.

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

**Do not use parentheses around your
template string or you will open yourself up to SQL injection attacks and you
will have a bad day.**

```js
let type = 'pancake \'; DELETE FROM accounts; --'
// NOTE THE PARENTHESES AROUND THE BACKTICKS - DO NOT DO THIS
db.value(`
  SELECT COUNT(*)
  FROM breakfast
  WHERE type = ${type}
`)
```

If you need to interpolate an identifier such as a table name, the normal
escaping will wrap your value in single quotes. Use the `db.identifier` function
instead.

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

##### db.template\`SELECT ${a}...\`

Prepare a statement for later execution. This is good for testing functions that
dynamically generate SQL.

```js
let accountName = 'ACME'
let tableName = 'users'

let subquery = db.template`
  SELECT id
  FROM accounts
  WHERE name = ${accountName}
`
let query = db.template`
  SELECT a, b
  FROM ${db.identifier(tableName)}
  WHERE account_id IN (${subquery})
`

let results = await db.rows(query)
// [{a: , b: }, {a: , b: }, ...]

let rawSql = query.__unsafelyGetRawSql()
// SELECT a, b FROM "users" WHERE account_id IN (SELECT id FROM accounts WHERE name='ACME')
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

*alias of db.escapeLiteral*

escape a value for safe use in SQL queries, returns string

While this function is tested and probably secure, you should avoid using it.
Instead, use bind vars, as they are much more difficult to mess up.

##### db.escapeIdentifier(value)
escape a value for safe use as an identifier in SQL queries, returns string

Same as the above function, except for things like table names, column names,
etc.

##### db.escapeLiterals(values, separator = ', ')
escape an array of literals and join them with the given separator, returns string

```js
db.escapeLiterals(['a', 'b', 'c']) === "'a', 'b', 'c'"
```

##### db.escapeIdentifiers(values, separator = ', ')
escape an array of identifiers and join them with the given separator, returns string

```js
db.escapeIdentifiers(['a', 'b', 'c']) === '"a", "b", "c"'
```

##### db.identifier(value)
escapes an identifier in such a way that it can be passed safely into a template
query, returns object

Below, note the lack of parentheses around the SQL, with db.query being called
as a template function.

```js
let tableName = 'potentially "dangerous" table name'
db.query`
  SELECT * FROM ${db.identifier(tableName)}
`
```

##### db.identifiers(values, separator = ', ')
escapes multiple identifiers in such a way that they can be passed safely into a
template query, returns object

```js
let columns = ['id', 'name']
db.query`
  SELECT ${db.identifiers(columns)} FROM accounts
`
```

##### db.literals(values, separator = ', ')
escapes multiple literals in such a way that they can be passed safely into a
template query, returns object

```js
let accounts = [1, 2, 3]
db.query`
  SELECT id FROM accounts WHERE name IN(${db.literals(accounts)})
`
```

### Contributing

Please send pull requests!
