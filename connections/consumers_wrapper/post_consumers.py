import aiohttp
import asyncio
import json
import configparser
import io
import base64
from datetime import date, datetime
from .update_periodically_consumer import get_device_from_list_by_id, append_device_to_persistant_list
from channels.generic.websocket import AsyncWebsocketConsumer

from ..utils.logger import Logger


class PostConsumer(AsyncWebsocketConsumer):
  # Websocket consumer that handles POST requests received.
  # The 'post_to_socket' VIEW receive the request, call 'receive_post' method from this class and send it to JS.
  # Receive msgs from JS, with the 'receive' method and send it to the specific device(s) with HTTP request (POST or GET)

  def __init__(self) -> None:
      super().__init__()
      self.async_tasks = []
      self.keep_sending_tasks = {}

  async def connect(self):
    # Called when websocket connection is required (when corresponding url is accessed).
    global post_consumer_instance
    await self.accept()
    # Instantiate itself, so 'post_to_socket' view can access this class method.
    post_consumer_instance = self


  async def disconnect(self, close_code):
    # Called when websocket connection is closed.
    for task in self.async_tasks:
      task.cancel()
    if len(self.keep_sending_tasks.keys()) > 0:
      for task in self.keep_sending_tasks.values():
        task.cancel()
    print(f'Post websocket disconnected {close_code}')


  async def send_post_specific_device(self, url, device_type, id, json_to_send):
    # Send POST request to specific URL (representing a specific device)
    async with aiohttp.ClientSession() as session:
      print(f'Enviando: {json_to_send}')

      # Logging the information to send
      logger.log_info(source='gs', data=json_to_send, code_origin='send-post')

      async with session.post(url, json=json_to_send) as resp:
        response = await resp.json()
        print(f'Django recebeu resposta do POST request: {response}')

        # Logging the response
        source = device_type + '-' + str(id)
        logger.log_info(source=source, data=response, code_origin='send-post-response')
        # Updating the interface with the response
        await self.send(json.dumps(response))


  async def upload_file_to_device(self, url, device_type, id, file_data):
    # Upload file to a device through HTTP POST endpoint
    print("Calling upload_file_to_device")
    async with aiohttp.ClientSession() as session:
      file_data["content"] = io.BytesIO(base64.b64decode(file_data["content"]))
      print(f'Enviando: {file_data}')

      # Logging the information to send
      data = aiohttp.FormData()
      data.add_field('file', file_data["content"], filename=file_data["filename"], content_type=file_data["type"])
      
      logger.log_info(source='gs', data=file_data, code_origin='upload-post')
      print(f"Sending http request to url {url}")
      async with session.post(url, data=data) as resp:
        response = await resp.json()
        print(f'Django recebeu resposta do POST request: {response}')

        # Logging the response
        source = device_type + '-' + str(id)
        logger.log_info(source=source, data=response, code_origin='upload-post-response')
        # Updating the interface with the response
        await self.send(json.dumps(response))

  async def send_get_specific_device(self, url, id, device_type):
    # Send GET request to specific URL (representing a specific device), wait for response and send to JS via socket
    async with aiohttp.ClientSession() as session:
      logger.log_info(source='gs', data=url, code_origin='send-get')
      
      async with session.get(url) as resp:
        response_from_device = await resp.json(content_type=None)
        print(f'Django recebeu resposta do GET request: {response_from_device}')

        # Logging the GET request response and original information
        source = device_type + '-' + str(id)
        logger.log_info(source=source, data=response_from_device, code_origin='send-get-response')
        # Updating the interface with the response
        await self.send(json.dumps(response_from_device))


  async def keep_sending(self, command, device_receiver_id):
    # Get from persistant list all the registred devices
    device_to_send_list = get_device_from_list_by_id(device_receiver_id)
    while True:
      device_tasks = []
      for device in device_to_send_list:
        # Get the specific command path of the endpoint address
        command_path_list = config['commands-list'][command].split(',')
        endpoint = command_path_list[0]
        url = "http://" + device['ip'] + endpoint

        # Create the GET request task
        task = asyncio.create_task(self.send_get_specific_device(url, device['id'], device['device']))
        device_tasks.append(task)
      await asyncio.gather(*device_tasks, return_exceptions=True)

  async def treat_checkbox_cmds(self, command, device_receiver_id):
    command = str(command)
    # Auxiliary function to check and execute special command to keep the order to cancel a mission or not
    cmds_to_keep_sending = [cmd for cmd in config['checkbox-commands']['keep_sending'].split(",")]
    cmds_to_stop_sending = [cmd for cmd in config['checkbox-commands']['stop_sending'].split(",")]

    if command in cmds_to_stop_sending:
      # Checkbox to cancel all missions is not checked anymore
      command_to_stop = str(int(command)-1) # Getting the corresponding 'keep sending' command
      print("Stopping to keep sending command:", command_to_stop)
      if command_to_stop in self.keep_sending_tasks.keys():
        self.keep_sending_tasks[command_to_stop].cancel()
        try:
          await self.keep_sending_tasks[command_to_stop]
        except asyncio.CancelledError:
          pass
        del self.keep_sending_tasks[command_to_stop]
        print("Current keep_sending_tasks:",self.keep_sending_tasks.keys())
    elif command in cmds_to_keep_sending:
      # Checkbox to cancel all missions is checked. Creating a task to keep sending command
      self.keep_sending_tasks[command] = asyncio.create_task(self.keep_sending(command, device_receiver_id))


  async def send_via_http(self, text_data):
    # The command received via socket will be processed
    # There is two types of command, trigged by a checkbox button and a regular button
    # The button type will be checked and treated accordingly 
    received_json = json.loads(text_data)

    button_type = received_json['button_type']
    device_receiver_id = str(received_json['receiver'])
    command = str(received_json['type'])
    print("button_type", button_type)
    # It'll search the 'persistent device list' for available device, with matching id,
    # Or get all persistent list if device_receiver_id is 'all'.
    device_to_send_list = get_device_from_list_by_id(device_receiver_id)

    
    if button_type == "checkbox":
      # Checkbox commands are treat differently. treat_checkbox_cmds() have the logic to handle it
      await self.treat_checkbox_cmds(int(command), device_receiver_id)
    elif button_type == "upload":
      print("Handling upload command")
      # Upload commands are treated differently. The data is sent to the device via POST request
      for device in device_to_send_list:
        # Building the device ip to send the HTTP request
        ip = "http://" + device['ip']
        id = str(device['id'])

        # Getting inside config.ini the "endpoint,type_of_request", based on the command (int)
        command_path_list = config['commands-list'][command].split(',')
        endpoint = command_path_list[0]
        type_of_request = 'post' # Upload commands are always a POST request
        url = ip + endpoint

        json_to_send = received_json["data"]
        task = asyncio.create_task(self.upload_file_to_device(url, device['device'], id, json_to_send))
        self.async_tasks.append(task)
    else:
      print("running regular command")
      # Regular button commands can be a POST or GET request
      # The mapping is done inside congig.ini, where it gets the command (int) and returns endpoint,type_of_request (string)
      for device in device_to_send_list:
        # Building the device ip to send the HTTP request
        ip = "http://" + device['ip']
        id = str(device['id'])

        # Getting inside config.ini the "endpoint,type_of_request", based on the command (int)
        command_path_list = config['commands-list'][command].split(',')
        endpoint = command_path_list[0]
        type_of_request = command_path_list[1]
        url = ip + endpoint
        print("command", command)
        print("endpoint", endpoint)
        json_to_send = received_json["data"]
        if type_of_request == 'get':
          #GET request
          task = asyncio.create_task(self.send_get_specific_device(url, id, device['device']))
        else:
          # POST request
          task = asyncio.create_task(self.send_post_specific_device(url, device['device'], id, json_to_send))
        self.async_tasks.append(task)


  async def receive(self, text_data):
    # Receive msg (text_data) from socket and call 'send_via_http' method to handle it
    try: 
      await self.send_via_http(text_data)
    except:
      logger.log_except()
  async def receive_post(self, data):
    # Called from 'post_to_socket' view, when a POST arrives from a device
    data['method'] = 'post'
    data['time'] = get_time_now().replace('"', '')
    data['status'] = 'active'

    append_device_to_persistant_list(data)

    source = data['device'] + '-' + str(data['id'])
    if "type" in data:
      print(f"Type recebido: {data['type']}")
    logger.log_info(source=source, data=data, code_origin='receive-info')
    try:
      await self.send(json.dumps(data)) # Send to JS via socket
    except Exception:
      logger.log_except()



# Auxiliary functions
# -------------------
def get_post_consumer_instance():
  global post_consumer_instance
  return post_consumer_instance


def get_time_now():
  return json.dumps(datetime.now(), default=json_serializer)


def json_serializer(obj):
  # Function to help formatting 
  if isinstance(obj, (datetime, date)):
    return obj.isoformat()
  raise TypeError ("Type %s not serializable" % type(obj))


def replicate_dict_new_id(id, json_to_send):
  # Create a new dict changing it's 'ID' key
  new_dict = {}
  for key, item in json_to_send.items():
    if key == 'id':
      new_dict[key] = id
    else:
      new_dict[key] = item
  return new_dict
# End of Auxiliary functions
# -------------------


# --- Pre-process to get .ini info ---
config = configparser.ConfigParser()
config.read('config.ini')
# --- End of pre-processing ---

post_consumer_instance = None
logger = Logger()
