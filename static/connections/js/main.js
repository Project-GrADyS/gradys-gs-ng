// The IP+Port of the server is imported from config.ini. Django passes it as parameter to index.html, when it's rendered.
// The IP+Port format is http://ip:port/
// Striping the IP and Port:
const serverIpPort = serverAddress.split(/http:\/\//)[1].split(':');
const serverIp = serverIpPort[0];
const serverPort = serverIpPort[1].slice(0, -1);

// Starting websocket connections
var observableSocket = new WebSocket(`ws://${serverIp}:${serverPort}/ws/connection/`);
var sendCommandSocket = new WebSocket(`ws://${serverIp}:${serverPort}/ws/receive/`);
var receivePostSocket = new WebSocket(`ws://${serverIp}:${serverPort}/ws/update-info/`);
var updateSocket = new WebSocket(`ws://${serverIp}:${serverPort}/ws/update-periodically/`);

// List of active devices that'll show at 'select' field
var activeDevicesId = []

// Control if the log text autoscroll is available or not
var autoScroll = true;

if(receivePostSocket.readyState === WebSocket.CONNECTING){
  document.querySelector('#ip-connected').innerText = "Background: Connecting";
}

// Set the interface status to connected, if POST socket is Open
receivePostSocket.addEventListener('open', function (event) {
  document.querySelector('#ip-connected').innerText = "Background: Online";
});


function sendCommand(cmdNumber, buttonType="default", data={}) {
  // Send the selected command to a set of devices, obtained from getDeviceReceive()
  //
  // Format of command-json that will be sent:
  // id - (int) id of the groundstation
  // cmdNumber - (int) integer that represent what this command will do (see table of commands)
  // buttonType - (string) default or checkbox
  // receiver - (int) ID of the active device on the 'select-device list'
  //            note if the command will be sent to all devices, the ID will be 'all'
  jsonToSend = {id: 1, type: cmdNumber, button_type: buttonType, data: data}
  jsonToSend["receiver"] = getDeviceReceiver();

  jsonToSend = JSON.stringify(jsonToSend);
  console.log(jsonToSend);
  
  // Send the command to the Consumers.
  // The PostConsumer will receive the command and handle it
  if (receivePostSocket.readyState == WebSocket.OPEN) {
    receivePostSocket.send(jsonToSend);
    notifyUiWhenJsonSent(jsonToSend);
  }

  // The ReceiveCommandConsumer will receive the command and handle it
  // Note this is the Serial Consumer, in charge to stablish and change messages with serial connected device
  if (sendCommandSocket.readyState == WebSocket.OPEN) {
    //sendCommandSocket.send(jsonToSend);
    //notifyUiWhenJsonSent(jsonToSend);
  }
}



function getMatchingIndex(id) {
  //Return the index of the matching ID, in the list of active devices OR return -1 if not found
  var matchingId = -1;

  [...document.getElementById('select-device').children].forEach((option, index) => {
    if(option.value == id) matchingId = index;
  });

  return matchingId
}


function getDeviceReceiver() {
  // Return the device ID selected at 'select' field
  selectElement = document.getElementById('select-device');
  selectedDeviceId = selectElement.value;

  return selectedDeviceId;
}

function verifyActiveDevices(id) {
  // Search the list of active devices and
  // return true if found matching ID
  // return false if not found matching ID
  let match = false;
  activeDevicesId.forEach((deviceId) => {
    if(deviceId == id) match = true;
  });
  return match;
}

function pushNewCommandOption(id, deviceType) {
  // Insert in the 'select' field a new device option
  var selectElement = document.getElementById('select-device');
  var opt = new Option(`${deviceType.toUpperCase()} ${id}`, id);
  selectElement.add(opt);
}

function removeCommandOption(id) {
  // Remove from the 'select' field a device with matching id
  var selectElement = document.getElementById('select-device');
  const matchingId = getMatchingIndex(id);

  if(matchingId != -1) {
    selectElement.remove(matchingId);
    activeDevicesId = activeDevicesId.filter(deviceId => id !== deviceId);
  }
}

function notifyUiWhenJsonSent(jsonSent, message="Command sent: ") {
  // Insert on interface visual log the command sent.
  var element = document.getElementById('actions-logs');
  var p = document.createElement("p");
  p.appendChild(document.createTextNode(message + jsonSent));
  p.className += "json-sent";

  element.prepend(p);
}

function notifyUiWhenJsonReceived(jsonReceived, msg) {
  // Insert on interface visual log the message received
  var element = document.getElementById('actions-logs');
  var p = document.createElement("p");
  p.appendChild(document.createTextNode(msg + jsonReceived));
  p.className += "json-received";

  element.prepend(p);
  if(autoScroll == true) {
    var elem= document.getElementById('logs');
    elem.scroll(0, 0);
  }
}

function checkJsonType(msg) {
  // The main logic to handle received messages
  // A message will try to be parsed to JSON format, and it's 'type' will contain what the message represents
  // The type 102 represents a location update message, and it'll be reflected on Google Maps.
  // All messages are shown on interface visual log
  try {
    var djangoData = JSON.parse(msg.data);
    console.log(djangoData);
    json_type = djangoData['type'];

    msgUi = 'ACK: ';
    msgDefault = 'JSON unknown: ';
    msgDrone = `${djangoData['device'].toUpperCase()} info: `;

    switch(json_type) {
      case 102: // Device information received
        var id = djangoData['id'];
        var lat = parseFloat(djangoData['lat']);
        var lng = parseFloat(djangoData['lng']);
        var status = djangoData.hasOwnProperty('status') ? djangoData['status'] : 'active';
        var deviceType = djangoData.hasOwnProperty('device') ? djangoData['device'] : 'teste';

        // Add device as a new option in Select list, if not already included
        if(!verifyActiveDevices(id)){
          if(status != 'inactive') {
            activeDevicesId.push(id);
            pushNewCommandOption(id, deviceType);
          }
        }
        else {
          //Retira device se está nas opções e está inativo
          if(status == 'inactive') {
            removeCommandOption(id);
          }
        }

        notifyUiWhenJsonReceived(msg.data, msgDrone);
        // Insert/Update the marker on Google Maps, with it's location
        try {
          gmap.newMarker(id, lat, lng, status, deviceType);
        } catch(e) {
          console.error("Error connecting to google maps")
        }
        break;

      // The default behavior to other types not included above
      default:
        msgDefault = djangoData.hasOwnProperty('device') ? msgDrone : msgDefault;
        notifyUiWhenJsonReceived(msg.data, msgDefault);
        break;
    }
  } catch(e) {
    // If it's not a JSON, it'll show the message on interface visual log
    notifyUiWhenJsonReceived(msg.data);
  }
}

function checkScroll(checkbox) {
  if(checkbox.checked) {
    autoScroll = true;
  }
  else {
    autoScroll = false;
  }
}

function checkAbort(checkbox) {
  if(checkbox.checked) {
    sendCommand(30, "checkbox");
  }
  else {
    sendCommand(31, "checkbox");
  }
}

receivePostSocket.onmessage = function(msg) {
  checkJsonType(msg);
}

observableSocket.onmessage = function(msg) {
  checkJsonType(msg);
}

updateSocket.onmessage = function(msg) {
  checkJsonType(msg);
}


//On close functions
//-------------------
observableSocket.onclose = function(e) {
  console.error('Connection socket closed unexpectedly');
};

sendCommandSocket.onclose = function(e) {
  console.error('Send command socket closed unexpectedly');
};

receivePostSocket.onclose = function(e) {
  document.querySelector('#ip-connected').innerText = "";
  document.querySelector('#ip-disconnected').innerText = 'Background: Offline';
  console.error('Receive POST socket closed unexpectedly');
}

updateSocket.onclose = function(e) {
  console.error('Update socket closed unexpectedly');
}


// Onclick functions
//-------------------
// Table of commands:
// 20: /telemetry/gps
// 22: /telemetry/ned
// 30: /command/rtl
// 32: /command/takeoff
document.querySelector('#position-gps').onclick = function(e) {
  sendCommand(20);
};

document.querySelector('#position-ned').onclick = function(e) {
  sendCommand(22);
};

document.querySelector('#arm').onclick = function(e) {
  sendCommand(24);
}

document.querySelector('#takeoff').onclick = function(e) {
  sendCommand(32);
};


document.querySelector('#upload').onclick = function(e) {
  // This is the button to upload a file. It will mantain the file, sending to the correct uav via POST Request, when Submit button is pressed
  // This button will trigger the GET Request to obtain the correct uav IP, based on the ID. The 'action' field, on form, will be replaced with the correct IP
  const url = serverAddress + "get-uav-ip/";
  const id = getDeviceReceiver();
  const data = {'id': id};
  let form = document.getElementById('form');
  
  fetch(url, {
    method:"POST",
    credentials: 'same-origin',
    headers:{
      'Accept': 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
    },
    body: JSON.stringify(data)
  }).then(response => {
    return response.json();
  }).then(data => {
    form.action = data.ip + "mission/uplaoad-script";
  }).catch(() => {
    console.log("Error while getting uav ip");
  });
};


var form = document.querySelector("form");
form.addEventListener('submit', (e) => {
  // Logic for submit button, to upload a file
  // It will make a post request to the form 'action' address
  let data = new FormData();
  let fileInput = document.getElementById('upload');
  data.append("file", fileInput.files[0]);

  let request = new XMLHttpRequest();
  let url = form.action;

  request.open("POST", url, true);
  
  request.send(data);
  notifyUiWhenJsonSent("File uploaded successfully!", "")
  e.preventDefault();
});

var inputBtn = document.getElementById("upload");
inputBtn.addEventListener('input', () => {
  // Logic for the file submission button condition
  // When the file button changes its state, it will be chekced the submit button condition
  // If there is a file, the submite button is enabled. Otherwise, it'll be disabled
  let submitBtn = document.getElementById("submit-file");
  let submitLabel = document.getElementById("submit-label");
  let inputIcon = document.getElementById("input-icon");
  let primaryColor = getComputedStyle(document.documentElement).getPropertyValue('--primary-color');
  let darkGrayColor = getComputedStyle(document.documentElement).getPropertyValue('--dark-gray-color');

  if(inputBtn.files.length != 0) {
    submitBtn.disabled = false;
    submitLabel.className = "custom-submit-file";
    inputIcon.style.color = primaryColor;
  }
  else {
    submitBtn.disabled = true;
    submitLabel.className = "custom-submit-file-disabled";
    inputIcon.style.color = darkGrayColor;
  }
});