let pg = require('pg')
let parseConnectionString = require('pg-connection-string').parse

function connect (server) {
  if (typeof server === 'string') {
    server = parseConnectionString(server)
  } else if (typeof server === 'undefined') {
    server = {}
  }

  server.poolSize = server.poolSize || process.env.PG_POOL_SIZE
  server.poolIdleTimeout = (
    server.poolIdleTimeout ||
    process.env.PG_IDLE_TIMEOUT ||
    (process.env.NODE_ENV === 'test' && 1)
  )
  server.reapIntervalMillis = (
    server.reapIntervalMillis ||
    process.env.PG_REAP_INTERVAL ||
    (process.env.NODE_ENV === 'test' && 50)
  )

  return new Promise(function doConnection (resolve, reject) {
    return pg.connect(server, function onConnect (err, client, done) {
      if (err) {
        reject(err)
      } else {
        resolve([client, done])
      }
    })
  })
}

const INTERFACE = {
  query (client, sql, params) {
    return new Promise(function doQuery (resolve, reject) {
      client.query(sql, params, function onResult (err, result) {
        if (err) {
          reject(err)
        } else {
          resolve(result)
        }
      })
    })
  },
  rows (client, sql, params) {
    return INTERFACE.query(client, sql, params).then(
      (result) => result.rows
    )
  },
  row (client, sql, params) {
    return INTERFACE.query(client, sql, params).then(
      (result) => result.rows[0]
    )
  },
  value (client, sql, params) {
    return INTERFACE.row(client, sql, params).then(
      (row) => row && row[ Object.keys(row)[0] ]
    )
  },
  column (client, sql, params) {
    return INTERFACE.query(client, sql, params).then(
      (result) => {
        let col = result.rows[0] && Object.keys(result.rows[0])[0]
        return result.rows.map(
          (row) => row[col]
        )
      }
    )
  }
}

function withConnection (server, work) {
  let client
  let done
  return (
    connect(server)
      .then(function onConnect (conn) {
        client = conn[0]
        done = conn[1]
        return work(client)
      })
      .then(function onResult (result) {
        done()
        return result
      })
      .catch(function onError (err) {
        if (done) {
          if (err instanceof Error && err.ABORT_CONNECTION) {
            // this is a really bad one, remove the connection from the pool
            done(err)
          } else {
            done()
          }
        }
        if (done) done()
        throw err
      })
  )
}

function configure (server) {
  let iface = {
    transaction (work) {
      let trxIface
      return withConnection(server, function doTransaction (client) {
        trxIface = Object.keys(INTERFACE).reduce(function linkInterface (i, methodName) {
          i[methodName] = INTERFACE[methodName].bind(null, client)
          return i
        }, {})

        let result
        let inTransaction

        return (
          trxIface.query('begin')
            .then(function onBegin () {
              inTransaction = true
              return work(trxIface)
            })
            .then(function onResult (_result) {
              result = _result
              return trxIface.query('commit')
            })
            .then(function onCommit () {
              return result
            })
            .catch(function onError (err) {
              if (!inTransaction) throw err

              return (
                trxIface.query('rollback')
                  .catch(function onRollbackFail (rollbackErr) {
                    err = (err instanceof Error ? err.message + '\n' + err.stack : err)
                    rollbackErr = (rollbackErr instanceof Error ? rollbackErr.message + '\n' + rollbackErr.stack : rollbackErr)
                    let bigErr = new Error(
                      'Failed to execute rollback after error\n' +
                      err + '\n\n' + rollbackErr
                    )
                    bigErr.ABORT_CONNECTION = true
                    throw bigErr
                  })
                  .then(function onRollback (r) {
                    throw err
                  })
              )
            })
        )
      })
    }
  }

  iface = Object.keys(INTERFACE).reduce(function linkInterface (i, methodName) {
    i[methodName] = function (sql, params) {
      return withConnection(server, function onConnect (client) {
        return INTERFACE[methodName](client, sql, params)
      })
    }
    i[methodName].displayName = methodName
    return i
  }, iface)

  return iface
}

let main = configure(process.env.DATABASE_URL)
main.configure = configure

module.exports = main
