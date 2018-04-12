// @flow

import { FillLayoutArray } from '../array_types';

import { members as layoutAttributes } from './fill_attributes';
import SegmentVector from '../segment';
import { ProgramConfigurationSet } from '../program_configuration';
import { LineIndexArray, TriangleIndexArray } from '../index_array_type';
import loadGeometry from '../load_geometry';
import earcut from 'earcut';
import classifyRings from '../../util/classify_rings';
import assert from 'assert';
const EARCUT_MAX_RINGS = 500;
import { register } from '../../util/web_worker_transfer';

import type {
    Bucket,
    BucketParameters,
    IndexedFeature,
    PopulateParameters
} from '../bucket';
import type FillStyleLayer from '../../style/style_layer/fill_style_layer';
import type Context from '../../gl/context';
import type IndexBuffer from '../../gl/index_buffer';
import type VertexBuffer from '../../gl/vertex_buffer';
import type Point from '@mapbox/point-geometry';
import type {ImagePosition} from '../../render/image_atlas';


export type FillFeature = {|
    index: number,
    sourceLayerIndex: number,
    geometry: Array<Array<Point>>,
    properties: Object,
    type: 1 | 2 | 3,
    id?: any
|};

class FillBucket implements Bucket {
    index: number;
    zoom: number;
    overscaling: number;
    layers: Array<FillStyleLayer>;
    layerIds: Array<string>;

    layoutVertexArray: FillLayoutArray;
    layoutVertexBuffer: VertexBuffer;

    indexArray: TriangleIndexArray;
    indexBuffer: IndexBuffer;

    indexArray2: LineIndexArray;
    indexBuffer2: IndexBuffer;

    programConfigurations: ProgramConfigurationSet<FillStyleLayer>;
    segments: SegmentVector;
    segments2: SegmentVector;
    uploaded: boolean;
    features: Array<FillFeature>;
    imagePositions: {[string]: ImagePosition};

    constructor(options: BucketParameters<FillStyleLayer>) {
        this.zoom = options.zoom;
        this.overscaling = options.overscaling;
        this.layers = options.layers;
        this.layerIds = this.layers.map(layer => layer.id);
        this.index = options.index;

        this.layoutVertexArray = new FillLayoutArray();
        this.indexArray = new TriangleIndexArray();
        this.indexArray2 = new LineIndexArray();
        this.programConfigurations = new ProgramConfigurationSet(layoutAttributes, options.layers, options.zoom);
        this.segments = new SegmentVector();
        this.segments2 = new SegmentVector();
    }

    populate(features: Array<IndexedFeature>, options: PopulateParameters) {
        const icons = options.iconDependencies;
        this.features = [];

        const dataDrivenPatternLayers = [];
        for (let i = 0; i < this.layers.length; i++) {
            const layer = this.layers[i];
            const fillPattern = layer.paint.get('fill-pattern');
            if (fillPattern.value.kind === "source" || fillPattern.value.kind === "composite") {
                dataDrivenPatternLayers.push(layer);
            } else {
                // add all icons needed for this layer to the tile's IconAtlas dependencies
                // for non-data-driven line-pattern properties
                const images = fillPattern.property.getPossibleOutputs();
                for (let i = 0; i < images.length; i++) {
                    // https://github.com/facebook/flow/issues/4310
                    icons[(images[i]: any)] = true;
                }
            }
        }

        for (const {feature, index, sourceLayerIndex} of features) {
            if (this.layers[0]._featureFilter({zoom: this.zoom}, feature)) {
                for (let i = 0; i < dataDrivenPatternLayers.length; i++) {
                    const layer = dataDrivenPatternLayers[i];
                    const fillPattern = layer.paint.get('fill-pattern');
                    const image = fillPattern.evaluate(feature);
                    if (image) {
                        icons[image.min] = true;
                        icons[image.mid] = true;
                        icons[image.max] = true;
                    }
                }

                const geometry = loadGeometry(feature);
                const fillFeature: FillFeature = {
                    sourceLayerIndex: sourceLayerIndex,
                    index: index,
                    geometry: geometry,
                    properties: feature.properties,
                    type: feature.type
                };

                if (typeof feature.id !== 'undefined') {
                    fillFeature.id = feature.id;
                }

                this.features.push(fillFeature);
                options.featureIndex.insert(feature, geometry, index, sourceLayerIndex, this.index);
            }
        }
    }

    addFeatures(options: PopulateParameters, imagePositions: {[string]: ImagePosition}) {
        this.imagePositions = imagePositions;
        for (const feature of this.features) {
            const {geometry} = feature;
            this.addFeature(feature, geometry);
        }
    }

    isEmpty() {
        return this.layoutVertexArray.length === 0;
    }

    upload(context: Context) {
        this.layoutVertexBuffer = context.createVertexBuffer(this.layoutVertexArray, layoutAttributes);
        this.indexBuffer = context.createIndexBuffer(this.indexArray);
        this.indexBuffer2 = context.createIndexBuffer(this.indexArray2);
        this.programConfigurations.upload(context);
    }

    destroy() {
        if (!this.layoutVertexBuffer) return;
        this.layoutVertexBuffer.destroy();
        this.indexBuffer.destroy();
        this.indexBuffer2.destroy();
        this.programConfigurations.destroy();
        this.segments.destroy();
        this.segments2.destroy();
    }

    addFeature(feature: FillFeature, geometry: Array<Array<Point>>) {
        for (const polygon of classifyRings(geometry, EARCUT_MAX_RINGS)) {
            let numVertices = 0;
            for (const ring of polygon) {
                numVertices += ring.length;
            }

            const triangleSegment = this.segments.prepareSegment(numVertices, this.layoutVertexArray, this.indexArray);
            const triangleIndex = triangleSegment.vertexLength;

            const flattened = [];
            const holeIndices = [];

            for (const ring of polygon) {
                if (ring.length === 0) {
                    continue;
                }

                if (ring !== polygon[0]) {
                    holeIndices.push(flattened.length / 2);
                }

                const lineSegment = this.segments2.prepareSegment(ring.length, this.layoutVertexArray, this.indexArray2);
                const lineIndex = lineSegment.vertexLength;

                this.layoutVertexArray.emplaceBack(ring[0].x, ring[0].y);
                this.indexArray2.emplaceBack(lineIndex + ring.length - 1, lineIndex);
                flattened.push(ring[0].x);
                flattened.push(ring[0].y);

                for (let i = 1; i < ring.length; i++) {
                    this.layoutVertexArray.emplaceBack(ring[i].x, ring[i].y);
                    this.indexArray2.emplaceBack(lineIndex + i - 1, lineIndex + i);
                    flattened.push(ring[i].x);
                    flattened.push(ring[i].y);
                }

                lineSegment.vertexLength += ring.length;
                lineSegment.primitiveLength += ring.length;
            }

            const indices = earcut(flattened, holeIndices);
            assert(indices.length % 3 === 0);

            for (let i = 0; i < indices.length; i += 3) {
                this.indexArray.emplaceBack(
                    triangleIndex + indices[i],
                    triangleIndex + indices[i + 1],
                    triangleIndex + indices[i + 2]);
            }

            triangleSegment.vertexLength += numVertices;
            triangleSegment.primitiveLength += indices.length / 3;
        }
        this.programConfigurations.populatePaintArrays(this.layoutVertexArray.length, feature, this.imagePositions);
    }
}

register('FillBucket', FillBucket, {omit: ['layers']});

export default FillBucket;
