"""可选 M3 配合试样；从顶视图左到右三档，底面 Z=0，单位 mm。"""
from math import sqrt
from build123d import RectangleRounded, RegularPolygon, Cylinder, extrude, Pos, Align

def gen_step():
    sample=extrude(RectangleRounded(36,18,2),amount=5)
    for x,hole,across_flats in [(-12,3.2,5.6),(0,3.4,5.8),(12,3.6,6.0)]:
        sample-=Pos(x,-4.5,-1)*Cylinder(hole/2,7,align=(Align.CENTER,Align.CENTER,Align.MIN))
        sample-=Pos(x,4.5,-1)*Cylinder(3.4/2,7,align=(Align.CENTER,Align.CENTER,Align.MIN))
        sample-=Pos(x,4.5,2)*extrude(RegularPolygon(across_flats/sqrt(3),6),amount=4)
    sample.label='optional_m3_fit_coupon'
    return sample
