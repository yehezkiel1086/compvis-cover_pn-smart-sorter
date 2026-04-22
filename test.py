import torch
print(torch.cuda.is_available())       # Should print: True
print(torch.cuda.get_device_name(0))   # Should print: NVIDIA GeForce GTX 1650

from roboflow import Roboflow

rf = Roboflow(api_key="Zl7wopgsTvuIIFsfJAca")

# Get workspace and print details
workspace = rf.workspace()
print("Workspace ID:", workspace.name)
print("\nProjects:")
for project in workspace.projects():
    print(f"  - ID: {project.id}  |  Name: {project.name}")
