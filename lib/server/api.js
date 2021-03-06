/**
 * The server-side SDC Portal API.
 *
 * NOTE: This module is not isomorphic, and requiring it on the client will
 * break. Please use `lib/clients/portal` instead.
 */
var util = require('util');
var bodyParser = require('body-parser');
var session = require('cookie-session');
var express = require('express');
var when = require('when');
var SDCClient = require('../clients/sdc.js');
var config = require('../config');
var Machine = require('../models/machine');
var User = require('../models/user');

/**
 * Generates an Express subapp for the internal SDC Portal API.
 */
function generateSubapp(options) {
  var subapp = express();
  var authProvider = options.authProvider;
  var client = new SDCClient();

  subapp.use(bodyParser.json());

  subapp.use(authProvider.subapp());

  subapp.get('/signin', authProvider.signin());
  subapp.get('/signout', authProvider.signout());

  subapp.get('/verify', function (req, res, next) {
    return authProvider.getActiveDeveloper(req)
      .then(function (developer) {
        return res
          .status(200)
          .send({
            developer: developer
          });
      });
  });

  /**
   * Ensure a developer is signed-in.
   */
  subapp.use(function (req, res, next) {
    return authProvider.getActiveDeveloper(req)
      .then(function (developer) {
        if (!developer) {
          return res
            .status(401)
            .end();
        }

        next();
      });
  });

  /**
   * Gets the list of data centers the Portal server is configured for.
   * Requires a signed-in developer.
   */
  subapp.get('/datacenters', function (req, res, next) {
    return res
      .status(200)
      .send({
        dataCenters: Object.keys(config.sdc.dataCenters)
      });
  });

  /**
   * Gets the list of sdc users the currently signed in user has access to.
   * Requires a signed-in developer.
   */
  subapp.get('/datacenters/:dc/users', function (req, res, next) {
    // TODO(schoon) - Support non-linked SDC deployments.
    return authProvider.getUsers(req)
      .then(function (usernames) {
        return usernames.map(function (username) {
          return User.createUser({ login: username });
        });
      })
      .then(function (users) {
        return res
          .status(200)
          .send({
            users: users
          });
      });
  });

  /**
   * Ensure the signed-in developer has access to :dc/:user.
   */
  subapp.use('/datacenters/:dc/users/:user', function (req, res, next) {
    return authProvider.getUsers(req)
      .then(function (users) {
        if (users.indexOf(req.param('user')) === -1) {
          return res
            .status(403)
            .send({
              message: 'not authorized to access SDC user'
            });
        }

        next();
      });
  });

  /**
   * Retrieves a user in :dc with id :user.
   */
  subapp.get('/datacenters/:dc/users/:user', function (req, res, next) {
     var userName = req.param('user');
     var dc = req.param('dc');

     // TODO - if :user is a sub-user, call getUser() and listUserKeys() instead
     client
       .getAccount(userName, dc, userName)
       .then(function (user) {
         return User.createUser(user)
           .loadExtendedData(client.getChild({
             user: userName,
             dataCenter: dc
           }));
       })
       .then(function (user) {
         return res
           .status(200)
           .send({
             user: user
           });
       }, next);
   });

  /**
   * Retrieves a list of Machines on :dc associated with :user.
   */
  subapp.get('/datacenters/:dc/users/:user/machines', function (req, res, next) {
    client
      .listMachines(req.param('user'), req.param('dc'))
      .then(function (machines) {
        return when.all(
          machines
            .map(Machine.createMachine)
            .filter(function (machine) {
              return machine.isActive();
            })
            .map(function (machine) {
              return machine.loadExtendedData(client.getChild({
                user: req.param('user'),
                dataCenter: req.param('dc')
              }));
            })
        );
      })
      .then(function (machines) {
        return res
          .status(200)
          .send({
            machines: machines
          });
      }, next);
  });

  /**
   * Ensure :dc/:id exists, retrieving it for use in other middleware.
   */
  subapp.use('/datacenters/:dc/users/:user/machines/:id', function (req, res, next) {
    client
      .getMachine(req.param('user'), req.param('dc'), req.param('id'))
      .then(function (machine) {
        if (!machine) {
          res
            .status(404)
            .send({
              message: 'Machine not found'
            });
        }

        req.machine = machine;

        next();
      }, next);
  });

  /**
   * Gets the Machine data for :dc/:id. The signed-in developer must have
   * access to the associated :user, and :dc/:id must exist.
   */
  subapp.get('/datacenters/:dc/users/:user/machines/:id', function (req, res, next) {
    Machine.createMachine(req.machine)
      .loadExtendedData(client.getChild({
        user: req.param('user'),
        dataCenter: req.param('dc')
      }))
      .then(function (machine) {
        res.send(machine);
      });
  });

  /**
   * Queues a "reboot" action for :dc/:id. The signed-in developer must have
   * access to the associated :user, and :dc/:id must exist.
   */
  subapp.post('/datacenters/:dc/users/:user/machines/:id/reboot', function (req, res, next) {
    if (req.machine.state !== 'running') {
      return res
        .status(400)
        .send({
          message: 'machine can only be rebooted if in state \'running\''
        });
    }

    client
      .rebootMachine(req.param('user'), req.param('dc'), req.param('id'))
      .then(function () {
        return res
          .status(202)
          .end();
      }, next);
  });

  /**
   * Queues a "start" action for :dc/:id. The signed-in developer must have
   * access to the associated :user, and :dc/:id must exist.
   */
  subapp.post('/datacenters/:dc/users/:user/machines/:id/start', function (req, res, next) {
    if (req.machine.state !== 'stopped') {
      return res
        .status(400)
        .send({
          message: 'machine can only be started if in state \'stopped\''
        });
    }

    client
      .startMachine(req.param('user'), req.param('dc'), req.param('id'))
      .then(function () {
        return res
          .status(202)
          .end();
      }, next);
  });

  /**
   * Queues a "stop" action for :dc/:id. The signed-in developer must have
   * access to the associated :user, and :dc/:id must exist.
   */
  subapp.post('/datacenters/:dc/users/:user/machines/:id/stop', function (req, res, next) {
    if (req.machine.state !== 'running') {
      return res
        .status(400)
        .send({
          message: 'machine can only be stopped if in state \'running\''
        });
    }

    client
      .stopMachine(req.param('user'), req.param('dc'), req.param('id'))
      .then(function () {
        return res
          .status(202)
          .end();
      }, next);
  });

  /**
   * Creates a SSH key for the specified :user
   */
  subapp.post('/datacenters/:dc/users/:user/sshkeys', function (req, res, next) {
    if (!req.body.key) {
      return res
        .status(400)
        .send({
          message: 'must specify public key'
        });
    }

    client
      .createKey(req.param('user'), req.param('dc'), {
        name: req.body.name,
        key: req.body.key
      })
      .then(function (createdKey) {
        return res
          .status(201)
          .send({
            sshKey: {
              name: createdKey.name,
              key: createdKey.key,
              fingerprint: createdKey.fingerprint
            }
          });
      })
      .catch(function (error) {
        return error && error.statusCode === 409;
      }, function (error) {
           return res
             .status(400)
             .send({
               message: 'public key is already in use or is invalid'
             });
         }
      );
  });

  return subapp;
}

/*!
 * Export `generateSubapp`.
 */
module.exports = {
  generateSubapp: generateSubapp
};
