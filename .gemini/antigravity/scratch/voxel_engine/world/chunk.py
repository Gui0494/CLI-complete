import numpy as np
import moderngl as mgl
import glm
from numba import njit
from settings import *
from world.terrain import generate_chunk_terrain

# PRE-DEFINED CONSTANTS FOR NUMBA
# Directions: Front, Back, Right, Left, Top, Bottom
DIRECTIONS = (
    (0,0,1), (0,0,-1), (1,0,0), (-1,0,0), (0,1,0), (0,-1,0)
)

# Face Vertices (x, y, z, uv_id)
# 0: Front (+z), 1: Back (-z), 2: Right (+x), 3: Left (-x), 4: Top (+y), 5: Bottom (-y)
FACE_VERTS = (
    # Face 0: Front (+z) | (0,0,1) -> (1,0,1)
    ((0,0,1,0), (1,0,1,1), (1,1,1,2), (0,0,1,0), (1,1,1,2), (0,1,1,3)),
    # Face 1: Back (-z)
    ((1,0,0,0), (0,0,0,1), (0,1,0,2), (1,0,0,0), (0,1,0,2), (1,1,0,3)),
    # Face 2: Right (+x)
    ((1,0,1,0), (1,0,0,1), (1,1,0,2), (1,0,1,0), (1,1,0,2), (1,1,1,3)),
    # Face 3: Left (-x)
    ((0,0,0,0), (0,0,1,1), (0,1,1,2), (0,0,0,0), (0,1,1,2), (0,1,0,3)),
    # Face 4: Top (+y)
    ((0,1,1,0), (1,1,1,1), (1,1,0,2), (0,1,1,0), (1,1,0,2), (0,1,0,3)),
    # Face 5: Bottom (-y)
    ((0,0,0,0), (1,0,0,1), (1,0,1,2), (0,0,0,0), (1,0,1,2), (0,0,1,3)),
)

@njit
def build_chunk_mesh(voxels, chunk_pos):
    # Using a list in numba is valid but strictly typed usually. 
    # Initialize with a dummy value to infer type if needed, or rely on JIT inference.
    vertex_data = [] 
    
    # We can simple use integers since we pack everything
    
    for x in range(CHUNK_W):
        for y in range(CHUNK_H):
            for z in range(CHUNK_D):
                voxel_id = voxels[x, y, z]
                if voxel_id == 0:
                    continue
                
                # Check 6 faces
                for face_id in range(6):
                    # Unpack direction tuple manually or use constant indexing
                    dx = DIRECTIONS[face_id][0]
                    dy = DIRECTIONS[face_id][1]
                    dz = DIRECTIONS[face_id][2]
                    
                    nx, ny, nz = x + dx, y + dy, z + dz
                    
                    is_visible = False
                    if 0 <= nx < CHUNK_W and 0 <= ny < CHUNK_H and 0 <= nz < CHUNK_D:
                        if voxels[nx, ny, nz] == 0:
                            is_visible = True
                    else:
                        is_visible = True 
                    
                    if is_visible:
                        verts = FACE_VERTS[face_id]
                        # internal loop 6 verts
                        for i in range(6):
                            vx = verts[i][0]
                            vy = verts[i][1]
                            vz = verts[i][2]
                            uv_id = verts[i][3]
                            
                            rx, ry, rz = x + vx, y + vy, z + vz
                            
                            # Packed format
                            # Ensure we cast to uint32 inside the packing to prevent overflow issues in signed ints
                            packed = (np.uint32(rx) & 63) | \
                                     ((np.uint32(ry) & 255) << 6) | \
                                     ((np.uint32(rz) & 63) << 14) | \
                                     ((np.uint32(face_id) & 7) << 20) | \
                                     ((np.uint32(uv_id) & 3) << 23) | \
                                     ((np.uint32(voxel_id) & 127) << 25)
                            vertex_data.append(packed)
                            
    return vertex_data

class Chunk:
    def __init__(self, world, position):
        self.world = world
        self.position = position 
        self.m_model = glm.translate(glm.mat4(), glm.vec3(position[0]*CHUNK_W, position[1]*CHUNK_H, position[2]*CHUNK_D))
        
        self.voxels = generate_chunk_terrain(position[0], position[1], position[2], seed=42)
        
        self.vbo = None
        self.vao = None
        self.is_empty = True
        
        self.build_mesh()
        
    def build_mesh(self):
        vertex_data = build_chunk_mesh(self.voxels, self.position)
        
        if len(vertex_data) == 0:
            self.is_empty = True
            return
            
        self.is_empty = False
        # Convert list to numpy array
        vertex_data_np = np.array(vertex_data, dtype='uint32')
        
        if self.vbo:
            self.vbo.write(vertex_data_np)
        else:
            self.vbo = self.world.ctx.buffer(vertex_data_np)
            
        if not self.vao:
            self.vao = self.world.ctx.vertex_array(
                self.world.shader, [(self.vbo, '1u', 'packed_data')]
            )

    def render(self):
        if not self.is_empty and self.vao:
            self.world.shader['m_model'].write(self.m_model)
            self.vao.render()
