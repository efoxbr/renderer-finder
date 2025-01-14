var dgram  = require('dgram')
var util   = require('util')
var debug  = require('debug')('renderer-finder')
var events = require('events')
var http   = require('http')
var concat = require('concat-stream')
var xml2js = require('xml2js')

function getDiscoverMessage(ST) {
  var buf  = Buffer.from(
    "M-SEARCH * HTTP/1.1\r\n" +
    "HOST:239.255.255.250:1900\r\n" +
    "MAN:\"ssdp:discover\"\r\n" +
    "ST: " + (ST || "urn:schemas-upnp-org:device:MediaRenderer:1") + "\r\n" +
    "MX:2\r\n" +
    "\r\n"
  )
  debug('Discover message: ' + buf.toString())
  return buf;
}

function parseDiscoverResponse(buffer){
  debug('parsing discover buffer response')
  var response = {};
  var parts = buffer.toString().split('\r\n')
  for (var i = 0; i < parts.length; i++){
    if (i > 0){
      response[parts[i].split(': ')[0].toLowerCase()] = parts[i].split(': ')[1];
    }else{
      response.Status = parts[i];
    }
  }
  return response;
}

function parseDescriptionResponse(xml, cb){
  const parser = new xml2js.Parser()
  parser.on('error', console.error) // avoid fatal errors
  parser.parseStringPromise(xml).then(json => {
    var newJson = {
      device: {},
      service: []
    };
    var device = json.root.device[0];
    for (var porp in device) {
      if (device.hasOwnProperty(porp) && porp !== 'serviceList') {
        newJson.device[porp] = device[porp][0];
      }
    }
    var services = device.serviceList[0].service;
    for (var serv in services) {
      if (services.hasOwnProperty(serv)) {
        newJson.service.push({
          SCPDURL: services[serv].SCPDURL[0],
          controlURL: services[serv].controlURL[0],
          eventSubURL: services[serv].eventSubURL[0],
          serviceId: services[serv].serviceId[0],
          serviceType: services[serv].serviceType[0]
        })
      }
    }
    cb(null, newJson)    
  }).catch(function (err) {
    cb(err)
  })
}

function getDeviceDescription(url, cb){
  debug('getting device description')
  fetch(url, function(err, body) {
    if(err)
      return cb(err)

    debug('converting XML to JSON')
    parseDescriptionResponse(body, cb)
  })
}

function fetch(url, cb) {
  debug('making HTTP request: '+ url)
  var req = http.get(url, function(res) {
    if(res.statusCode !== 200) {
      var err = new Error('Request failed')
      err.statusCode = res.statusCode;
      return cb(err)
    }
    debug('piping response')
    res.pipe(concat(function(buf) {
      debug('response piped')
      cb(null, buf.toString())
    }))
  }).on('error', cb)
  req.end()
}

function getSocket(ST, cb) {
  var client = dgram.createSocket("udp4")
  var server = dgram.createSocket("udp4")
  client.bind() // So that we get a port so we can listen before sending
  var msg = getDiscoverMessage(ST)
  debug('Client: sending message')
  client.send(msg, 0, msg.length, 1900, "239.255.255.250", function(err){
    if (err){
      cb(err)
    }
    debug('Client: message sended')

    var port = client.address().port;

    client.close()
    cb(undefined, server, port)
  })
  return server;
}

function RendererFinder(ST){
  //inherit all the event stuff
  events.EventEmitter.call(this)

  var that = this;
  var sST = ST;
  var _socket = null;

  that.start = function(gatherInfo){
    debug('Finder: getting socket')
    _socket = getSocket(sST, function(err, socket, port){
      if (err){
        that.emit('error', err)
        return
      }
      debug('Finder: socket obtained')

      socket.on("message", function (msg, rinfo) {
        var parsedMsg = parseDiscoverResponse(msg)
        debug('Finder: device found %o', rinfo)
        debug('                     %o', parsedMsg)
        if (gatherInfo){
          getDeviceDescription(parsedMsg.location, function(err, desc){
            console.warn('getDeviceDescription '+err+' | '+desc, rinfo, parsedMsg, desc)
            if (err){
              that.emit('error', err)
            }
            that.emit('found', rinfo, parsedMsg, desc)
          })
        }else{
          that.emit('found', rinfo, parsedMsg)
        }
    	})

      socket.on("error", function (buf) {
        debug('Finder: device founder error %s', buf.toString())
        that.emit('error', buf.toString())
    	})

      socket.bind(port)
    })

    return this;
  };

  that.stop = function(){
    debug('Finder: stopping')
    if (_socket)
      _socket.close()
  };

  that.findOne = function(getInfo, cb){
    //check for the optional parameter
    cb = getInfo instanceof Function ? getInfo : cb;
    getInfo = getInfo instanceof Function ? false : getInfo;

    that.once('found', function(info, msg, desc){
      that.stop()
      cb(undefined, info, msg, desc)
    })
    that.once('error', function(err){
      that.stop()
      cb(err)
    })
    that.start(getInfo)
  };

  return that;
}

//inherit all the event stuff
util.inherits(RendererFinder, events.EventEmitter)

module.exports = RendererFinder;
